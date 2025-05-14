'use strict';

import sharp from 'sharp';
import archiver from 'archiver';

export const aaServeBundle = (app, repo, mercator, options, verbose) => {
  // NOTE(cg): Take an encoded list of zxy tiles and bundle them in a zip
  app.post('/:id/bundle', async (req, res, next) => {
    try {
      const { id } = req.params;
      const item = repo[id];

    if (verbose) {
      console.log(
        `Handling rendered bundle request for: /styles/%s`,
        String(id).replace(/\n|\r/g, ''),
      );
    }

      if (!item) {
        return res.sendStatus(404);
      }

      const w = req.query.width | 256;
      const h = req.query.height | 256;
      const scale = req.query.scale | 1;
      const format = req.query.format ?? 'jpeg';

      const transformer = item.dataProjWGStoInternalWGS;
      const tiles = extractEncodedTilesFromBody(req.body, transformer);

      const path = '/tmp/';
      const filename = crypto.randomUUID() + '.zip';
      // const filepath = path + filename;

      if (tiles.length) {
        const images = await Promise.all(
          tiles.map(({ z, x, y }) => {
            const tileCenter = mercator.ll(
              [
                ((x + 0.5) / (1 << z)) * (256 << z),
                ((y + 0.5) / (1 << z)) * (256 << z),
              ],
              z,
            );
            const filename = `z${z}x${x}y${y}.${format}`;
            return renderImage2(
              options,
              item,
              z,
              tileCenter[0],
              tileCenter[1],
              w,
              h,
              scale,
              format,
            ).then((bufferOrError) => {
              let result = null;
              if (typeof bufferOrError === 'string') {
                console.error(bufferOrError);
              } else if (bufferOrError) {
                result = { buffer: bufferOrError, filename: filename };
              }
              return result;
            });
          }),
        );

        res.attachment(filename);

        const zip = archiver('zip', { zlib: { level: 9 } });
        zip.pipe(res);
        for (const image of images) {
          if (!image) {
            continue;
          }
          zip.append(image.buffer, { name: image.filename });
        }
        zip.finalize();
      } else {
        res.sendStatus(204);
      }
    } catch (e) {
      console.log(e);
      return next(e);
    }
  });
};

/**
 * NOTE(cg): This is just a copy of `respondImage` without setting `res`, we just want the image.
 *  When pulling upstream changes, this will have to mirror that function if anything has changed. :(
 *
 * Responds with an image.
 * @param {object} options Configuration options.
 * @param {object} item Item object containing map and other information.
 * @param {number} z Zoom level.
 * @param {number} lon Longitude of the center.
 * @param {number} lat Latitude of the center.
 * @param {number} width Width of the image.
 * @param {number} height Height of the image.
 * @param {number} scale Scale factor.
 * @param {string} format Image format.
 * @returns {Promise<{Buffer|string|null}>}
 */
async function renderImage2(
  options,
  item,
  z,
  lon,
  lat,
  width,
  height,
  scale,
  format,
) {
  if (
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 85.06 ||
    lon !== lon ||
    lat !== lat
  ) {
    throw new Error('Invalid center');
  }

  if (
    Math.min(width, height) <= 0 ||
    Math.max(width, height) * scale > (options.maxSize || 2048) ||
    width !== width ||
    height !== height
  ) {
    throw new Error('Invalid size');
  }

  if (format === 'png' || format === 'webp') {
  } else if (format === 'jpg' || format === 'jpeg') {
    format = 'jpeg';
  } else {
    throw new Error(`Invalid format: ${format}`);
  }

  const tileMargin = Math.max(options.tileMargin || 0, 0);
  const pool = item.map.renderersStatic[scale];

  return new Promise((resolve, reject) => {
    pool.acquire((err, renderer) => {
      if (err) {
        console.error(err);
        return reject(new Error(err));
      }

      // For 512px tiles, use the actual maplibre-native zoom. For 256px tiles, use zoom - 1
      let mlglZ;
      if (width === 512) {
        mlglZ = Math.max(0, z);
      } else {
        mlglZ = Math.max(0, z - 1);
      }

      const params = {
        zoom: mlglZ,
        center: [lon, lat],
        width,
        height,
      };

      // HACK(Part 1) 256px tiles are a zoom level lower than maplibre-native default tiles. this hack allows tileserver-gl to support zoom 0 256px tiles, which would actually be zoom -1 in maplibre-native. Since zoom -1 isn't supported, a double sized zoom 0 tile is requested and resized in Part 2.
      if (z === 0 && width === 256) {
        params.width *= 2;
        params.height *= 2;
      }
      // END HACK(Part 1)

      if (z > 0 && tileMargin > 0) {
        params.width += tileMargin * 2;
        params.height += tileMargin * 2;
      }

      renderer.render(params, (err, data) => {
        pool.release(renderer);
        if (err) {
          console.error(err);
          return reject(new Error(err));
        }

        try {
          const image = sharp(data, {
            raw: {
              premultiplied: true,
              width: params.width * scale,
              height: params.height * scale,
              channels: 4,
            },
          });

          if (z > 0 && tileMargin > 0) {
            const y = mercator.px(params.center, z)[1];
            const yoffset = Math.max(
              Math.min(0, y - 128 - tileMargin),
              y + 128 + tileMargin - Math.pow(2, z + 8),
            );
            image.extract({
              left: tileMargin * scale,
              top: (tileMargin + yoffset) * scale,
              width: width * scale,
              height: height * scale,
            });
          }
          // HACK(Part 2) 256px tiles are a zoom level lower than maplibre-native default tiles. this hack allows tileserver-gl to support zoom 0 256px tiles, which would actually be zoom -1 in maplibre-native. Since zoom -1 isn't supported, a double sized zoom 0 tile is requested and resized here.

          if (z === 0 && width === 256) {
            image.resize(width * scale, height * scale);
          }
          // END HACK(Part 2)

          const composites = [];
          if (item.watermark) {
            const canvas = renderWatermark(width, height, scale, item.watermark);

            composites.push({ input: canvas.toBuffer() });
          }

          if (item.staticAttributionText) {
            const canvas = renderAttribution(
              width,
              height,
              scale,
              item.staticAttributionText,
            );

            composites.push({ input: canvas.toBuffer() });
          }

          if (composites.length > 0) {
            image.composite(composites);
          }

          // Legacy formatQuality is deprecated but still works
          const formatQualities = options.formatQuality || {};
          if (Object.keys(formatQualities).length !== 0) {
            console.log(
              'WARNING: The formatQuality option is deprecated and has been replaced with formatOptions. Please see the documentation. The values from formatQuality will be used if a quality setting is not provided via formatOptions.',
            );
          }
          const formatQuality = formatQualities[format];

          const formatOptions = (options.formatOptions || {})[format] || {};

          if (format === 'png') {
            image.png({
              progressive: formatOptions.progressive,
              compressionLevel: formatOptions.compressionLevel,
              adaptiveFiltering: formatOptions.adaptiveFiltering,
              palette: formatOptions.palette,
              quality: formatOptions.quality,
              effort: formatOptions.effort,
              colors: formatOptions.colors,
              dither: formatOptions.dither,
            });
          } else if (format === 'jpeg') {
            image.jpeg({
              quality: formatOptions.quality || formatQuality || 80,
              progressive: formatOptions.progressive,
            });
          } else if (format === 'webp') {
            image.webp({ quality: formatOptions.quality || formatQuality || 90 });
          }
          image.toBuffer((err, buffer, info) => {
            if (!buffer) {
              return reject(new Error('Not found'));
            }

            resolve(buffer);
          });
        } catch(e) {
          console.error(e);
          reject(new Error(e));
        }
      });
    });
  });
}

/**
 * Parses encoded zxy tiles provided via request body into a list of tile objects.
 *
 * @param {Object} body Request body.
 * @param {Object} body.encoded body param.
 * @param {Function} transformer Optional transform function.
 * @returns {Tile[]} tile objects
 */
const extractEncodedTilesFromBody = (body, transformer) => {
  const tiles = [];

  if (body && 'encoded' in body && body.encoded) {
    const encoded = Array.isArray(body.encoded) ? body.encoded : [body.encoded];

    // Z X Y triples are encoded according to:
    //   https://developers.google.com/maps/documentation/utilities/polylinealgorithm
    // The only difference is each value is encoded as it is, instead of the the offset from the previous point as
    // stated in the above link

    for (const it of encoded) {
      const length = it.length;

      let index = 0;
      while (index < length) {
        const zxy = [0, 0, 0];
        for (let i = 0; i < 3; i += 1) {
          let result = 1;
          let shift = 0;

          let b;
          do {
            b = it.charAt(index++).charCodeAt(0) - 63 - 1;
            result += b << shift;
            shift += 5;
          } while (b >= 0x1f);

          zxy[i] = result >> 1;
        }

        const [z, x, y] = zxy;
        const z2 = Math.pow(2, z);
        if (x < 0 || y < 0 || z < 0 || z > 20 || x >= z2 || y >= z2) {
          console.log('Skipping invalid tile %s (%s/%s/%s)', id, z, x, y);
        } else {
          const coords = transformer ? transformer([x, y]) : [x, y];
          /** @type {Tile} */
          const tile = { x: coords[0], y: coords[1], z: z };
          tiles.push(tile);
        }
      }
    }
  }

  return tiles;
};

