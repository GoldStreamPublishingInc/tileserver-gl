'use strict';

import sharp from 'sharp';
import archiver from 'archiver';

export const aaServeStaticMap = (app, repo) => {
  // Accept our (Googles) staticmap requests and reformat/redirect them to tileserver's format
  //  e.g. https://tiles.anglersatlas.com/osm/staticmap?size=468x468&center=53.94491,-122.74789&markers=53.94491,-122.74789&zoom=15
  //  e.g. https://tiles.anglersatlas.com/osm/staticmap?size=468x468&path=weight:3|color:0x4fc0c4FF|enc:ucskH%...&path=weight:3|color:0x4fc0c4FF|enc:y%60skH...
  app.get('/:id/staticmap', async (req, res, next) => {
    try {
      const item = repo[req.params.id];
      if (!item) {
        return res.sendStatus(404);
      }

      const markers = markerQueryFromAAMarkerQuery(req.query);
      const paths = pathQueryFromAAPathQuery(req.query);

      const size = req.query.size ?? '256x256';
      const [width, height] = size.split('x', 2);

      let url = `/${req.params.id}/static`;

      if (req.query.center && req.query.zoom) {
        const center = req.query.center;
        const [lat, lon] = center.split(',', 2);
        const zoom = req.query.zoom;

        url += `/${lon},${lat},${zoom}`;
      } else {
        url += '/auto';
      }

      url += `/${width}x${height}.png`;

      delete req.query['size'];
      delete req.query['center'];
      delete req.query['zoom'];
      delete req.query['path'];
      delete req.query['marker'];

      const parts = [];
      for (const key in req.query) {
        parts.push(`${key}=${req.query[key]}`);
      }
      parts.push(...markers);
      parts.push(...paths);
      if (markers.length || paths.length) {
        parts.push('latlng=1');
      }

      url += '?' + parts.joinn('&');

      return res.redirect(url);
    } catch (e) {
      next(e);
    }
  });
};

export const aaServeBundle = (app, repo, mercator, options) => {
  // NOTE(cg): Take an encoded list of zxy tiles and bundle them in a zip
  app.post('/:id/bundle', async (req, res) => {
    const item = repo[req.params.id];
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
          return renderImage(
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
  });
};

/**
 * NOTE(cg): This is just a copy of `respondImage` without setting `res`, we just want the image.
 *  When pulling upstream changes, this will have to mirror that function if anything has changed. :(
 *
 * @returns {Buffer|string|null}
 */
const renderImage = async (
  options,
  item,
  z,
  lon,
  lat,
  width,
  height,
  scale,
  format,
) => {
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
    throw new Error('Invalid format');
  }

  try {
    const tileMargin = 0;

    const pool = item.map.renderersStatic[scale];

    // pool.acquire((err, renderer) => ...
    const renderer = await new Promise((resolve, reject) => {
      pool.acquire((error, renderer) =>
        error ? reject(error) : resolve(renderer),
      );
    });

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
      width: width,
      height: height,
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

    // renderer.render(params, (err, data) => ...
    const data = await new Promise((resolve, reject) => {
      renderer.render(params, (err, data) => {
        pool.release(renderer);
        return err ? reject(err) : resolve(data);
      });
    });

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

    const formatQuality = (options.formatQuality || {})[format];

    if (format === 'png') {
      image.png({ adaptiveFiltering: false });
    } else if (format === 'jpeg') {
      image.jpeg({ quality: formatQuality || 80 });
    } else if (format === 'webp') {
      image.webp({ quality: formatQuality || 90 });
    }

    const buffer = await image.toBuffer();
    if (!buffer) {
      throw new Error('Not found');
    }

    return buffer;
  } catch (error) {
    console.error(error);
  }

  return null;
};

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

const markerQueryFromAAMarkerQuery = (query) => {
  // Return an empty list if no markers have been provided
  if (!query.marker) {
    return [];
  }

  const markers = [];
  const providedMarkers = Array.isArray(query.marker)
    ? query.marker
    : [query.marker];
  for (const providedMmarker of providedMarkers) {
    /** @type {string[]} */
    const parts = providedMmarker.split('|');
    // location is always last (I hope)
    const location = parts[parts.length - 1];

    let icon = null;
    let options = '';
    for (const part of parts.slice(0, parts.length - 1)) {
      const split = part.indexOf(':');
      const option = part.substring(0, split);
      const value = part.substring(split + 1);

      if (option == 'icon') {
        icon = `|${value}`;
      } else {
        options += `|${part}`;
      }
    }

    if (!icon) {
      icon = '|https://www.anglersatlas.com/media/markers/trip-dot.png';
      options += '|anchor:center';
    }

    const marker = location + icon + options;
    markers.push(`marker=${marker}`);
  }

  return markers;
};

const pathQueryFromAAPathQuery = (query) => {
  if (!query.path) {
    return [];
  }

  const paths = [];
  const providedPaths = Array.isArray(query.path) ? query.path : [query.path];
  for (const providedPath of providedPaths) {
    const parts = providedPath.split('|');

    let options = {};
    let coords = [];
    for (const part of parts) {
      const split = part.indexOf(':');

      if (split == -1) {
        coords.push(part);
      } else {
        let option = part.substring(0, split);
        let value = part.substring(split + 1);

        // rename weight -> width
        if (option == 'weight') {
          option = 'width';
        }

        // rename color -> stroke and hex color to rgba
        if (option == 'color') {
          let r = 255;
          let g = 255;
          let b = 255;
          let a = 1.0;

          // convert from 0xrrggbbaa/0xrrggbb to rgba(...)
          if (value.startsWith('0x') || value.startsWith('0X')) {
            const end = value.length;
            const hex = parseInt(value.substring(2, end), 16);
            r = (hex >> 24) & 255;
            g = (hex >> 16) & 255;
            b = (hex >> 8) & 255;
            if (end == 10) {
              a = ((hex & 255) / 255).toFixed(1);
            }
          }

          option = 'stroke';
          value = `rgba(${r} ${g} ${b} ${a})`;
        }

        options[option] = value;
      }
    }

    if (coords.length) {
      latlng = true;

      const path = `path=${coords.join('|')}`;
      paths.push(path);

      for (const q in options) {
        const option = `${q}=${options[q]}`;
        paths.push(option);
      }
    } else {
      const value = Object.keys(options)
        .map((it) => `${it}:${options[it]}`)
        .join('|');
      const path = `path=${value}`;
      paths.push(path);
    }
  }

  return paths;
};
