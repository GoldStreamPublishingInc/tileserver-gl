'use strict';

var advancedPool = require('advanced-pool'),
  fs = require('fs'),
  path = require('path'),
  url = require('url'),
  util = require('util'),
  archiver = require('archiver'),
  zlib = require('zlib'),
  shortid = require('shortid');

// sharp has to be required before node-canvas
// see https://github.com/lovell/sharp/issues/371
var sharp = require('sharp');

var { createCanvas, loadImage } = require('canvas'),
  clone = require('clone'),
  Color = require('color'),
  express = require('express'),
  mercator = new (require('@mapbox/sphericalmercator'))(),
  mbgl = require('@mapbox/mapbox-gl-native'),
  mbtiles = require('@mapbox/mbtiles'),
  proj4 = require('proj4'),
  request = require('request');

var utils = require('./utils');

var FLOAT_PATTERN = '[+-]?(?:\\d+|\\d+\.?\\d+)';

var getScale = function (scale) {
  return (scale || '@1x').slice(1, 2) | 0;
};

mbgl.on('message', function (e) {
  if (e.severity == 'WARNING' || e.severity == 'ERROR') {
    console.log('mbgl:', e);
  }
});

/**
 * Lookup of sharp output formats by file extension.
 */
var extensionToFormat = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp'
};

/**
 * Cache of response data by sharp output format and color.  Entry for empty
 * string is for unknown or unsupported formats.
 */
var cachedEmptyResponses = {
  '': new Buffer(0)
};

/**
 * Create an appropriate mbgl response for http errors.
 * @param {string} format The format (a sharp format or 'pbf').
 * @param {string} color The background color (or empty string for transparent).
 * @param {Function} callback The mbgl callback.
 */
function createEmptyResponse(format, color, callback) {
  if (!format || format === 'pbf') {
    callback(null, { data: cachedEmptyResponses[''] });
    return;
  }

  if (format === 'jpg') {
    format = 'jpeg';
  }
  if (!color) {
    color = 'rgba(255,255,255,0)';
  }

  var cacheKey = format + ',' + color;
  var data = cachedEmptyResponses[cacheKey];
  if (data) {
    callback(null, { data: data });
    return;
  }

  // create an "empty" response image
  var color = new Color(color);
  var array = color.array();
  var channels = array.length == 4 && format != 'jpeg' ? 4 : 3;
  sharp(new Buffer(array), {
    raw: {
      width: 1,
      height: 1,
      channels: channels
    }
  }).toFormat(format).toBuffer(function (err, buffer, info) {
    if (!err) {
      cachedEmptyResponses[cacheKey] = buffer;
    }
    callback(null, { data: buffer });
  });
}

module.exports = function (options, repo, params, id, publicUrl, dataResolver) {
  var app = express().disable('x-powered-by');

  var maxScaleFactor = Math.min(Math.floor(options.maxScaleFactor || 3), 9);
  var scalePattern = '';
  for (var i = 2; i <= maxScaleFactor; i++) {
    scalePattern += i.toFixed();
  }
  scalePattern = '@[' + scalePattern + ']x';

  var lastModified = new Date().toUTCString();

  var rootPath = options.paths.root;

  var watermark = params.watermark || options.watermark;

  var styleFile = params.style;
  var map = {
    renderers: [],
    sources: {}
  };

  var existingFonts = {};
  var fontListingPromise = new Promise(function (resolve, reject) {
    fs.readdir(options.paths.fonts, function (err, files) {
      if (err) {
        reject(err);
        return;
      }
      files.forEach(function (file) {
        fs.stat(path.join(options.paths.fonts, file), function (err, stats) {
          if (err) {
            reject(err);
            return;
          }
          if (stats.isDirectory()) {
            existingFonts[path.basename(file)] = true;
          }
        });
      });
      resolve();
    });
  });

  var styleJSON;
  var createPool = function (ratio, min, max) {
    var createRenderer = function (ratio, createCallback) {
      var renderer = new mbgl.Map({
        ratio: ratio,
        request: function (req, callback) {
          var protocol = req.url.split(':')[0];
          if (protocol == 'sprites') {
            var dir = options.paths[protocol];
            var file = unescape(req.url).substring(protocol.length + 3);
            fs.readFile(path.join(dir, file), function (err, data) {
              callback(err, { data: data });
            });
          } else if (protocol == 'fonts') {
            var parts = req.url.split('/');
            var fontstack = unescape(parts[2]);
            var range = parts[3].split('.')[0];
            utils.getFontsPbf(
              null, options.paths[protocol], fontstack, range, existingFonts
            ).then(function (concated) {
              callback(null, { data: concated });
            }, function (err) {
              callback(err, { data: null });
            });
          } else if (protocol == 'mbtiles') {
            var parts = req.url.split('/');
            var sourceId = parts[2];
            var source = map.sources[sourceId];
            var sourceInfo = styleJSON.sources[sourceId];
            var z = parts[3] | 0,
              x = parts[4] | 0,
              y = parts[5].split('.')[0] | 0,
              format = parts[5].split('.')[1];
            source.getTile(z, x, y, function (err, data, headers) {
              if (err) {
                if (options.verbose) console.log('MBTiles error, serving empty', err);
                createEmptyResponse(sourceInfo.format, sourceInfo.color, callback);
                return;
              }

              var response = {};
              if (headers['Last-Modified']) {
                response.modified = new Date(headers['Last-Modified']);
              }

              if (format == 'pbf') {
                try {
                  response.data = zlib.unzipSync(data);
                }
                catch (err) {
                  console.log("Skipping incorrect header for tile mbtiles://%s/%s/%s/%s.pbf", id, z, x, y);
                }
                if (options.dataDecoratorFunc) {
                  response.data = options.dataDecoratorFunc(
                    sourceId, 'data', response.data, z, x, y);
                }
              } else {
                response.data = data;
              }

              callback(null, response);
            });
          } else if (protocol == 'http' || protocol == 'https') {
            request({
              url: req.url,
              encoding: null,
              gzip: true
            }, function (err, res, body) {
              var parts = url.parse(req.url);
              var extension = path.extname(parts.pathname).toLowerCase();
              var format = extensionToFormat[extension] || '';
              if (err || res.statusCode < 200 || res.statusCode >= 300) {
                // console.log('HTTP error', err || res.statusCode);
                createEmptyResponse(format, '', callback);
                return;
              }

              var response = {};
              if (res.headers.modified) {
                response.modified = new Date(res.headers.modified);
              }
              if (res.headers.expires) {
                response.expires = new Date(res.headers.expires);
              }
              if (res.headers.etag) {
                response.etag = res.headers.etag;
              }

              response.data = body;
              callback(null, response);
            });
          }
        }
      });
      renderer.load(styleJSON);
      createCallback(null, renderer);
    };
    return new advancedPool.Pool({
      min: min,
      max: max,
      create: createRenderer.bind(null, ratio),
      destroy: function (renderer) {
        renderer.release();
      }
    });
  };

  var styleJSONPath = path.resolve(options.paths.styles, styleFile);
  styleJSON = clone(require(styleJSONPath));

  var httpTester = /^(http(s)?:)?\/\//;
  if (styleJSON.sprite && !httpTester.test(styleJSON.sprite)) {
    styleJSON.sprite = 'sprites://' +
      styleJSON.sprite
        .replace('{style}', path.basename(styleFile, '.json'))
        .replace('{styleJsonFolder}', path.relative(options.paths.sprites, path.dirname(styleJSONPath)));
  }
  if (styleJSON.glyphs && !httpTester.test(styleJSON.glyphs)) {
    styleJSON.glyphs = 'fonts://' + styleJSON.glyphs;
  }

  (styleJSON.layers || []).forEach(function (layer) {
    if (layer && layer.paint) {
      // Remove (flatten) 3D buildings
      if (layer.paint['fill-extrusion-height']) {
        layer.paint['fill-extrusion-height'] = 0;
      }
      if (layer.paint['fill-extrusion-base']) {
        layer.paint['fill-extrusion-base'] = 0;
      }
    }
  });

  var tileJSON = {
    'tilejson': '2.0.0',
    'name': styleJSON.name,
    'attribution': '',
    'minzoom': 0,
    'maxzoom': 20,
    'bounds': [-180, -85.0511, 180, 85.0511],
    'format': 'png',
    'type': 'baselayer'
  };
  var attributionOverride = params.tilejson && params.tilejson.attribution;
  Object.assign(tileJSON, params.tilejson || {});
  tileJSON.tiles = params.domains || options.domains;
  utils.fixTileJSONCenter(tileJSON);

  var dataProjWGStoInternalWGS = null;

  var queue = [];
  Object.keys(styleJSON.sources).forEach(function (name) {
    var source = styleJSON.sources[name];
    var url = source.url;

    if (url && url.lastIndexOf('mbtiles:', 0) === 0) {
      // found mbtiles source, replace with info from local file
      delete source.url;

      var mbtilesFile = url.substring('mbtiles://'.length);
      var fromData = mbtilesFile[0] == '{' &&
        mbtilesFile[mbtilesFile.length - 1] == '}';

      if (fromData) {
        mbtilesFile = mbtilesFile.substr(1, mbtilesFile.length - 2);
        var mapsTo = (params.mapping || {})[mbtilesFile];
        if (mapsTo) {
          mbtilesFile = mapsTo;
        }
        mbtilesFile = dataResolver(mbtilesFile);
        if (!mbtilesFile) {
          console.error('ERROR: data "' + mbtilesFile + '" not found!');
          process.exit(1);
        }
      }

      queue.push(new Promise(function (resolve, reject) {
        mbtilesFile = path.resolve(options.paths.mbtiles, mbtilesFile);
        var mbtilesFileStats = fs.statSync(mbtilesFile);
        if (!mbtilesFileStats.isFile() || mbtilesFileStats.size == 0) {
          throw Error('Not valid MBTiles file: ' + mbtilesFile);
        }
        map.sources[name] = new mbtiles(mbtilesFile, function (err) {
          map.sources[name].getInfo(function (err, info) {
            if (err) {
              console.error(err);
              return;
            }

            if (!dataProjWGStoInternalWGS && info.proj4) {
              // how to do this for multiple sources with different proj4 defs?
              var to3857 = proj4('EPSG:3857');
              var toDataProj = proj4(info.proj4);
              dataProjWGStoInternalWGS = function (xy) {
                return to3857.inverse(toDataProj.forward(xy));
              };
            }

            var type = source.type;
            Object.assign(source, info);
            source.type = type;
            source.tiles = [
              // meta url which will be detected when requested
              'mbtiles://' + name + '/{z}/{x}/{y}.' + (info.format || 'pbf')
            ];
            delete source.scheme;

            if (options.dataDecoratorFunc) {
              source = options.dataDecoratorFunc(name, 'tilejson', source);
            }

            if (!attributionOverride &&
              source.attribution && source.attribution.length > 0) {
              if (tileJSON.attribution.length > 0) {
                tileJSON.attribution += '; ';
              }
              tileJSON.attribution += source.attribution;
            }
            resolve();
          });
        });
      }));
    }
  });

  var renderersReadyPromise = Promise.all(queue).then(function () {
    // standard and @2x tiles are much more usual -> default to larger pools
    var minPoolSizes = options.minRendererPoolSizes || [8, 4, 2];
    var maxPoolSizes = options.maxRendererPoolSizes || [16, 8, 4];
    for (var s = 1; s <= maxScaleFactor; s++) {
      var i = Math.min(minPoolSizes.length - 1, s - 1);
      var j = Math.min(maxPoolSizes.length - 1, s - 1);
      var minPoolSize = minPoolSizes[i];
      var maxPoolSize = Math.max(minPoolSize, maxPoolSizes[j]);
      map.renderers[s] = createPool(s, minPoolSize, maxPoolSize);
    }
  });

  repo[id] = tileJSON;

  var tilePattern = '/' + id + '/:z(\\d+)/:x(\\d+)/:y(\\d+)' +
    ':scale(' + scalePattern + ')?\.:format([\\w]+)';

  var respondImage = function (z, lon, lat, bearing, pitch,
    width, height, scale, format, res, next,
    opt_overlay) {
    if (Math.abs(lon) > 180 || Math.abs(lat) > 85.06 ||
      lon != lon || lat != lat) {
      return res.status(400).send('Invalid center: ' + lat + ' ' + lon);
    }
    if (Math.min(width, height) <= 0 ||
      Math.max(width, height) * scale > (options.maxSize || 2048) ||
      width != width || height != height) {
      return res.status(400).send('Invalid size');
    }
    if (format == 'png' || format == 'webp') {
    } else if (format == 'jpg' || format == 'jpeg') {
      format = 'jpeg';
    } else {
      return res.status(400).send('Invalid format');
    }

    var pool = map.renderers[scale];
    pool.acquire(function (err, renderer) {
      var mbglZ = Math.max(0, z - 1);
      var params = {
        zoom: mbglZ,
        center: [lon, lat],
        bearing: bearing,
        pitch: pitch,
        width: width,
        height: height
      };
      if (z == 0) {
        params.width *= 2;
        params.height *= 2;
      }

      var tileMargin = Math.max(options.tileMargin || 0, 0);
      if (z > 2 && tileMargin > 0) {
        params.width += tileMargin * 2 * scale;
        params.height += tileMargin * 2 * scale;
      }

      renderer.render(params, function (err, data) {
        pool.release(renderer);
        if (err) {
          console.error(err);
          return;
        }

        var image = sharp(data, {
          raw: {
            width: params.width * scale,
            height: params.height * scale,
            channels: 4
          }
        });

        if (z > 2 && tileMargin > 0) {
          image.extract({ left: tileMargin * scale, top: tileMargin * scale, width: width * scale, height: height * scale });
        }

        if (z == 0) {
          // HACK: when serving zoom 0, resize the 0 tile from 512 to 256
          image.resize(width * scale, height * scale);
        }

        if (opt_overlay) {
          image.overlayWith(opt_overlay);
        }
        if (watermark) {
          var canvas = createCanvas(scale * width, scale * height);
          var ctx = canvas.getContext('2d');
          ctx.scale(scale, scale);
          ctx.font = '10px sans-serif';
          ctx.strokeWidth = '1px';
          ctx.strokeStyle = 'rgba(255,255,255,.4)';
          ctx.strokeText(watermark, 5, height - 5);
          ctx.fillStyle = 'rgba(0,0,0,.4)';
          ctx.fillText(watermark, 5, height - 5);

          image.overlayWith(canvas.toBuffer());
        }

        var formatQuality = (params.formatQuality || {})[format] ||
          (options.formatQuality || {})[format];

        if (format == 'png') {
          image.png({ adaptiveFiltering: false });
        } else if (format == 'jpeg') {
          image.jpeg({ quality: formatQuality || 80 });
        } else if (format == 'webp') {
          image.webp({ quality: formatQuality || 90 });
        }
        image.toBuffer(function (err, buffer, info) {
          if (!buffer) {
            return res.status(404).send('Not found');
          }

          res.set({
            'Last-Modified': lastModified,
            'Content-Type': 'image/' + format
          });
          return res.status(200).send(buffer);
        });
      });
    });
  };

  app.get(tilePattern, function (req, res, next) {
    var modifiedSince = req.get('if-modified-since'), cc = req.get('cache-control');
    if (modifiedSince && (!cc || cc.indexOf('no-cache') == -1)) {
      if (new Date(lastModified) <= new Date(modifiedSince)) {
        return res.sendStatus(304);
      }
    }

    var z = req.params.z | 0,
      x = req.params.x | 0,
      y = req.params.y | 0,
      scale = getScale(req.params.scale),
      format = req.params.format;
    if (z < 0 || x < 0 || y < 0 ||
      z > 20 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) {
      return res.status(404).send('Out of bounds');
    }
    var tileSize = 256;
    var tileCenter = mercator.ll([
      ((x + 0.5) / (1 << z)) * (256 << z),
      ((y + 0.5) / (1 << z)) * (256 << z)
    ], z);
    return respondImage(z, tileCenter[0], tileCenter[1], 0, 0,
      tileSize, tileSize, scale, format, res, next);
  });

  var extractPathFromQuery = function (query, transformer) {
    var pathParts = (query.path || '').split('|');
    var path = [];
    pathParts.forEach(function (pair) {
      var pairParts = pair.split(',');
      if (pairParts.length == 2) {
        var pair;
        if (query.latlng == '1' || query.latlng == 'true') {
          pair = [+(pairParts[1]), +(pairParts[0])];
        } else {
          pair = [+(pairParts[0]), +(pairParts[1])];
        }
        if (transformer) {
          pair = transformer(pair);
        }
        path.push(pair);
      }
    });
    return path;
  };

  // markers=icon:https://www.anglersatlas.com/assets/markers/public/hotspot.png|52.9565965485168,-122.406575594336
  var extractGoogleMarkersFromQuery = function (query, transformer) {
    if (!query.markers) {
      return null;
    }

    var parts = (query.markers || '').split('|');
    if (parts.length == 0) {
      return null;
    }

    var marker = {};

    parts.forEach(function (part) {
      // if this part starts with a letter, then it's a styling property
      if (/^[a-zA-Z]/.test(part)) {
        var split = part.indexOf(':');
        if (split > -1) {
          var property = part.substring(split, -1);
          var value = part.substring(split + 1);
          marker[property] = value;
        }
      } else {
        var latLng = part.split(',');
        var pair = [+(latLng[1]), +(latLng[0])];
        if (transformer) {
          pair = transformer(pair);
        }
        marker.point = pair;
      }
    });

    return [marker];
  };

  // path=color:0x00000000|weight:1|52.926691,-122.4412496|52.9715978,-122.4412496|52.9715978,-122.4007407|52.926691,-122.4007407|52.926691,-122.4412496
  var extractGooglePathsFromQuery = function (query, transformer) {
    if (!query.path) {
      return null;
    }

    var queryPaths = Array.isArray(query.path) ? query.path : [query.path];
    return queryPaths.map(function (queryPath) {
      var parts = (queryPath || '').split('|');
      if (parts.length == 0) {
        return null;
      }

      var path = {
        points: [],
        weight: 5,
        color: '#6073EB', // default MyCatch :tm: colour
        // fillcolor: 'rgba(1.0, 1.0, 1.0, 0.5)',
        // geodesic: false
      };

      parts.forEach(function (part) {
        // If this part starts with a letter, then it's a styling property
        if (/^[a-zA-Z]/.test(part)) {
          const style = part.split(':');
          const property = style[0];
          const value = style[1];
          if (property === 'enc') {
            const encoded = value;
            const encodedLength = encoded.length;
            var index = 0;

            var lat = 0, lng = 0;
            while (index < encodedLength) {
              var result = 1;
              var shift = 0;
              var b; // int

              do {
                b = encoded.charAt(index++).charCodeAt(0) - 63 - 1;
                result += b << shift;
                shift += 5;
              } while (b >= 0x1f);
              lat += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);

              result = 1;
              shift = 0;
              do {
                b = encoded.charAt(index++).charCodeAt(0) - 63 - 1;
                result += b << shift;
                shift += 5;
              } while (b >= 0x1f);
              lng += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);

              var pair = [
                ((+lng) * 1e-5).toFixed(5),
                ((+lat) * 1e-5).toFixed(5)
              ];
              if (transformer) {
                pair = transformer(pair);
              }
              path.points.push(pair);
            }
          }
          // canvas doesn't support colours with 0x..., but does support #...
          else if (property == 'color' && value.startsWith('0x')) {
            path[property] = '#' + value.substring(2);
          } else {
            path[property] = value;
          }
        }
        // otherwise this is a point of the path
        else {
          var latLng = part.split(',');
          var pair = [+(latLng[1]), +(latLng[0])];
          if (transformer) {
            pair = transformer(pair);
          }
          path.points.push(pair);
        }
      });

      return path;
    })
      .filter(function (path) {
        return path != null;
      });
  };

  var renderOverlay = function (z, x, y, bearing, pitch, w, h, scale,
    path, query) {
    if (!path || path.length < 2) {
      return null;
    }
    var precisePx = function (ll, zoom) {
      var px = mercator.px(ll, 20);
      var scale = Math.pow(2, zoom - 20);
      return [px[0] * scale, px[1] * scale];
    };

    var center = precisePx([x, y], z);

    var mapHeight = 512 * (1 << z);
    var maxEdge = center[1] + h / 2;
    var minEdge = center[1] - h / 2;
    if (maxEdge > mapHeight) {
      center[1] -= (maxEdge - mapHeight);
    } else if (minEdge < 0) {
      center[1] -= minEdge;
    }

    var canvas = createCanvas(scale * w, scale * h);
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    if (bearing) {
      ctx.translate(w / 2, h / 2); k
      ctx.rotate(-bearing / 180 * Math.PI);
      ctx.translate(-center[0], -center[1]);
    } else {
      // optimized path
      ctx.translate(-center[0] + w / 2, -center[1] + h / 2);
    }
    var lineWidth = query.width !== undefined ?
      parseFloat(query.width) : 1;
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = query.stroke || 'rgba(0,64,255,0.7)';
    ctx.fillStyle = query.fill || 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    path.forEach(function (pair) {
      var px = precisePx(pair, z);
      ctx.lineTo(px[0], px[1]);
    });
    if (path[0][0] == path[path.length - 1][0] &&
      path[0][1] == path[path.length - 1][1]) {
      ctx.closePath();
    }
    ctx.fill();
    if (lineWidth > 0) {
      ctx.stroke();
    }

    return canvas.toBuffer();
  };

  var renderOverlayGoogle = function (z, x, y, width, height, scale, paths, markers, query) {
    return new Promise(function (resolve, reject) {
      if (!paths && !markers) {
        resolve(null);
      }

      var precisePx = function (latLng, zoom) {
        var px = mercator.px(latLng, 20);
        var scale = Math.pow(2, zoom - 20);
        return [px[0] * scale, px[1] * scale];
      };

      var center = precisePx([x, y], z);

      var mapHeight = 512 * (1 << z);
      var maxEdge = center[1] + height / 2;
      var minEdge = center[1] - height / 2;
      if (maxEdge > mapHeight) {
        center[1] -= (maxEdge - mapHeight);
      } else if (minEdge < 0) {
        center[1] -= minEdge;
      }

      var canvas = createCanvas(scale * width, scale * height);
      var ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      // TODO: handle bearing??
      ctx.translate(-center[0] + width / 2, -center[1] + height / 2);

      if (paths && paths.length) {
        paths.forEach(function (path) {
          ctx.lineWidth = path.weight;
          ctx.strokeStyle = path.color;
          ctx.fillStyle = path.fillcolor;

          ctx.beginPath();
          path.points.forEach(function (point) {
            var px = precisePx(point, z);
            ctx.lineTo(px[0], px[1]);
          });

          if (path.points[0][0] == path.points[path.points.length - 1][0] &&
            path.points[0][1] == path.points[path.points.length - 1][1]) {
            ctx.closePath();
          }

          if (path.fillcolor) {
            ctx.fill();
          }
          if (path.color && ctx.lineWidth > 0) {
            ctx.stroke()
          }
        });
      }

      var markerPromises = [];
      if (markers && markers.length) {
        var twoPi = 2 * Math.PI;
        markers.forEach(function (marker) {
          var promise;

          var px = precisePx(marker.point, z);
          if (marker.icon) {
            promise = new Promise(function (resolve, reject) {
              loadImage(marker.icon)
                .then(function (image) {
                  const imageWidth = image.width,
                    imageHeight = image.height;
                  // TODO: Handle anchor
                  const imageX = px[0] - (imageWidth / 2);
                  const imageY = px[1] - imageHeight;
                  ctx.drawImage(image, imageX, imageY, imageWidth, imageHeight);
                  resolve();
                })
                .catch(function (err) {
                  reject(err);
                });
            });
          } else {
            promise = new Promise(function (resolve) {
              ctx.fillStyle = '#f00';
              ctx.beginPath();
              ctx.arc(px[0], px[1], 10, 0, twoPi, false);
              ctx.fill();
              resolve();
            });
          }

          markerPromises.push(promise);
        });
      }

      Promise.all(markerPromises)
        .then(function () {
          return resolve(canvas.toBuffer());
        });
    });
  };

  var calcZForBBox = function (bbox, w, h, query) {
    var z = 25;

    var padding = query.padding !== undefined ?
      parseFloat(query.padding) : 0.1;

    var minCorner = mercator.px([bbox[0], bbox[3]], z),
      maxCorner = mercator.px([bbox[2], bbox[1]], z);
    var w_ = w / (1 + 2 * padding);
    var h_ = h / (1 + 2 * padding);

    z -= Math.max(
      Math.log((maxCorner[0] - minCorner[0]) / w_),
      Math.log((maxCorner[1] - minCorner[1]) / h_)
    ) / Math.LN2;

    z = Math.max(Math.log(Math.max(w, h) / 256) / Math.LN2, Math.min(25, z));

    return z;
  };

  if (options.serveStaticMaps !== false) {
    var staticPattern =
      '/' + id + '/static/:raw(raw)?/%s/:width(\\d+)x:height(\\d+)' +
      ':scale(' + scalePattern + ')?\.:format([\\w]+)';

    var centerPattern =
      util.format(':x(%s),:y(%s),:z(%s)(@:bearing(%s)(,:pitch(%s))?)?',
        FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN,
        FLOAT_PATTERN, FLOAT_PATTERN);

    app.get(util.format(staticPattern, centerPattern), function (req, res, next) {
      var raw = req.params.raw;
      var z = +req.params.z,
        x = +req.params.x,
        y = +req.params.y,
        bearing = +(req.params.bearing || '0'),
        pitch = +(req.params.pitch || '0'),
        w = req.params.width | 0,
        h = req.params.height | 0,
        scale = getScale(req.params.scale),
        format = req.params.format;

      if (z < 0) {
        return res.status(404).send('Invalid zoom');
      }

      var transformer = raw ?
        mercator.inverse.bind(mercator) : dataProjWGStoInternalWGS;

      if (transformer) {
        var ll = transformer([x, y]);
        x = ll[0];
        y = ll[1];
      }

      var path = extractPathFromQuery(req.query, transformer);
      var overlay = renderOverlay(z, x, y, bearing, pitch, w, h, scale,
        path, req.query);

      return respondImage(z, x, y, bearing, pitch, w, h, scale, format,
        res, next, overlay);
    });

    var serveBounds = function (req, res, next) {
      var raw = req.params.raw;
      var bbox = [+req.params.minx, +req.params.miny,
      +req.params.maxx, +req.params.maxy];
      var center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

      var transformer = raw ?
        mercator.inverse.bind(mercator) : dataProjWGStoInternalWGS;

      if (transformer) {
        var minCorner = transformer(bbox.slice(0, 2));
        var maxCorner = transformer(bbox.slice(2));
        bbox[0] = minCorner[0];
        bbox[1] = minCorner[1];
        bbox[2] = maxCorner[0];
        bbox[3] = maxCorner[1];
        center = transformer(center);
      }

      var w = req.params.width | 0,
        h = req.params.height | 0,
        scale = getScale(req.params.scale),
        format = req.params.format;

      var z = calcZForBBox(bbox, w, h, req.query),
        x = center[0],
        y = center[1],
        bearing = 0,
        pitch = 0;

      var path = extractPathFromQuery(req.query, transformer);
      var overlay = renderOverlay(z, x, y, bearing, pitch, w, h, scale,
        path, req.query);
      return respondImage(z, x, y, bearing, pitch, w, h, scale, format,
        res, next, overlay);
    };

    var boundsPattern =
      util.format(':minx(%s),:miny(%s),:maxx(%s),:maxy(%s)',
        FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN, FLOAT_PATTERN);

    app.get(util.format(staticPattern, boundsPattern), serveBounds);

    app.get('/' + id + '/static/', function (req, res, next) {
      for (var key in req.query) {
        req.query[key.toLowerCase()] = req.query[key];
      }
      req.params.raw = true;
      req.params.format = (req.query.format || 'image/png').split('/').pop();
      var bbox = (req.query.bbox || '').split(',');
      req.params.minx = bbox[0];
      req.params.miny = bbox[1];
      req.params.maxx = bbox[2];
      req.params.maxy = bbox[3];
      req.params.width = req.query.width || '256';
      req.params.height = req.query.height || '256';
      if (req.query.scale) {
        req.params.width /= req.query.scale;
        req.params.height /= req.query.scale;
        req.params.scale = '@' + req.query.scale;
      }

      return serveBounds(req, res, next);
    });

    var autoPattern = 'auto';

    app.get(util.format(staticPattern, autoPattern), function (req, res, next) {
      var raw = req.params.raw;
      var w = req.params.width | 0,
        h = req.params.height | 0,
        bearing = 0,
        pitch = 0,
        scale = getScale(req.params.scale),
        format = req.params.format;

      var transformer = raw ?
        mercator.inverse.bind(mercator) : dataProjWGStoInternalWGS;

      var path = extractPathFromQuery(req.query, transformer);
      if (path.length < 2) {
        return res.status(400).send('Invalid path');
      }

      var bbox = [Infinity, Infinity, -Infinity, -Infinity];
      path.forEach(function (pair) {
        bbox[0] = Math.min(bbox[0], pair[0]);
        bbox[1] = Math.min(bbox[1], pair[1]);
        bbox[2] = Math.max(bbox[2], pair[0]);
        bbox[3] = Math.max(bbox[3], pair[1]);
      });

      var bbox_ = mercator.convert(bbox, '900913');
      var center = mercator.inverse(
        [(bbox_[0] + bbox_[2]) / 2, (bbox_[1] + bbox_[3]) / 2]
      );

      var z = calcZForBBox(bbox, w, h, req.query),
        x = center[0],
        y = center[1];

      var overlay = renderOverlay(z, x, y, bearing, pitch, w, h, scale,
        path, req.query);

      return respondImage(z, x, y, bearing, pitch, w, h, scale, format,
        res, next, overlay);
    });
  }

  // http://localhost/staticmap
  //   ?path=color:0x00000000|weight:1|52.926691,-122.4412496|52.9715978,-122.4412496|52.9715978,-122.4007407|52.926691,-122.4007407|52.926691,-122.4412496
  //   &size=426x426
  //   &scale=2
  //   &markers=icon:https://www.anglersatlas.com/assets/markers/public/hotspot.png|52.9565965485168,-122.406575594336
  var staticMapPattern = '/' + id + '/staticmap';
  app.get(staticMapPattern, function (req, res, next) {
    var size = req.query.size;
    if (!size) {
      return res.status(400).send('Missing size parameter');
    }
    // TODO: Validate size is correctly formatted
    var sizeParts = size.split('x');
    var width = +sizeParts[0],
      height = +sizeParts[1];

    var scale = +(req.query.scale) || 1;
    if (scale != 1 && scale != 2 && scale != 4) {
      return res.status(400).send('Invalid scale. Valid values include 1, 2, 4.');
    }

    var transformer = dataProjWGStoInternalWGS;

    var markers = extractGoogleMarkersFromQuery(req.query, transformer);
    if (markers) {
      // TODO: marker validation? including its properties
      markers = markers.filter(function (marker) {
        return (marker.point && marker.point.length == 2);
      });
    }

    var paths = extractGooglePathsFromQuery(req.query, transformer);
    if (paths && paths.length > 0) {
      // TODO: path validation. including its properties
      paths = paths.filter(function (path) {
        return (path.points && path.points.length >= 2);
      });
    }

    var center, zoom, x, y;
    if (markers || paths) {
      const expandBBox = function (pair) {
        bbox[0] = Math.min(bbox[0], pair[0]);
        bbox[1] = Math.min(bbox[1], pair[1]);
        bbox[2] = Math.max(bbox[2], pair[0]);
        bbox[3] = Math.max(bbox[3], pair[1]);
      };

      var bbox = [Infinity, Infinity, -Infinity, -Infinity];

      if (paths && paths.length) {
        paths.forEach(function (path) {
          path.points.forEach(function (pair) {
            expandBBox(pair);
          });
        });
      }

      if (markers && markers.length) {
        markers.forEach(function (marker) {
          expandBBox(marker.point);
        });
      }

      var bbox_ = mercator.convert(bbox, '900913');
      center = mercator.inverse([
        (bbox_[0] + bbox_[2]) / 2,
        (bbox_[1] + bbox_[3]) / 2
      ]);

      zoom = calcZForBBox(bbox, width, height, req.query);
      x = center[0];
      y = center[1];
    }

    if (req.query.center) {
      const latLng = req.query.center.split(',');
      var pair = [+(latLng[1]), +(latLng[0])];
      if (transformer) {
        pair = transformer(pair);
      }
      center = pair;
      x = center[0];
      y = center[1];
    }
    if (req.query.zoom) {
      zoome = +req.query.zoom;
    }

    if (!center && !zoom && !x && !y) {
      return res.status(400).send('Missing one of center/zoom');
    }

    return renderOverlayGoogle(zoom, x, y, width, height, scale, paths, markers, req.query)
      .then(function (overlay) {
        respondImage(zoom, x, y, 0, 0, width, height, scale, 'png', res, next, overlay);
      })
      .then(function () {
        return app;
      })
      .catch(function (err) {
        return res.status(400).send(err);
      });
  });

  app.get('/' + id + '.json', function (req, res, next) {
    var info = clone(tileJSON);
    info.tiles = utils.getTileUrls(req, info.tiles,
      'styles/' + id, info.format, publicUrl);
    return res.send(info);
  });

  var renderImage = function (z, lon, lat, bearing, pitch, width, height, scale, format, filename, archive) {
    return new Promise(function (resolve, reject) {
      if (Math.abs(lon) > 180 || Math.abs(lat) > 85.06 || lon != lon || lat != lat) {
        const message = 'Invalid center: ' + lat + ' ' + lon + '\n';
        console.error(message);
        reject(message);
        return;
      }
      if (Math.min(width, height) <= 0 || Math.max(width, height) * scale > (options.maxSize || 2048) || width != width || height != height) {
        const message = 'Invalid size: ' + width + ' ' + height + ' ' + scale + '\n';
        console.error(message);
        reject(message);
        return;
      }
      if (format == 'png' || format == 'webp') {
        // we good fam
      } else if (format == 'jpg' || format == 'jpeg') {
        format = 'jpeg';
      } else {
        const message = 'Invalid format: ' + format + '\n';
        console.error(message);
        reject(message);
        return;
      }

      var pool = map.renderers[scale];
      pool.acquire(function (err, renderer) {
        var mbglZ = Math.max(0, z - 1);
        var params = {
          zoom: mbglZ,
          center: [lon, lat],
          bearing: bearing,
          pitch: pitch,
          width: width,
          height: height
        };
        if (z == 0) {
          params.width *= 2;
          params.height *= 2;
        }

        var tileMargin = Math.max(options.tileMargin || 0, 0);
        if (z > 2 && tileMargin > 0) {
          params.width += tileMargin * 2 * scale;
          params.height += tileMargin * 2 * scale;
        }

        renderer.render(params, function (err, data) {
          pool.release(renderer);
          if (err) {
            reject(err);
            return;
          }

          var image = sharp(data, {
            raw: {
              width: params.width * scale,
              height: params.height * scale,
              channels: 4
            }
          });

          if (z > 2 && tileMargin > 0) {
            image.extract({ left: tileMargin * scale, top: tileMargin * scale, width: width * scale, height: height * scale });
          }

          if (z == 0) {
            // HACK: when serving zoom 0, resize the 0 tile from 512 to 256
            image.resize(width * scale, height * scale);
          }

          var formatQuality = (params.formatQuality || {})[format] || (options.formatQuality || {})[format];
          if (format == 'png') {
            image.png({ adaptiveFiltering: false });
          } else if (format == 'jpeg') {
            image.jpeg({ quality: formatQuality || 80 });
          } else if (format == 'webp') {
            image.webp({ quality: formatQuality || 90 });
          }
          image.toBuffer(function (err, buffer, info) {
            if (!buffer) {
              reject('Not found');
              return;
            }

            archive.append(buffer, { name: filename });

            resolve();
          });
        });
      });
    });
  };

  // Bundle of tiles for list of ZXY's
  app.use(express.urlencoded({ extended: true }));
  app.post('/' + id + '/bundle', function (req, res) {
    var encoded = req.body['encoded'];
    var encodedLength = encoded.length;

    var format = 'png';

    const outputFilename = shortid.generate() + '.zip';
    var outputFilePath = '/data/' + outputFilename;
    var output = fs.createWriteStream(outputFilePath);
    var archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);

    var renderPromises = [];

    // Z X Y triples are encoded according to:
    //   https://developers.google.com/maps/documentation/utilities/polylinealgorithm
    // The only difference is each value is encoded as it is, instead of the the offset from the previous point as
    // stated in the above link

    var index = 0;
    while (index < encodedLength) {
      var result = 1;
      var shift = 0;
      var b; // int

      var z, x, y;

      do {
        b = encoded.charAt(index++).charCodeAt(0) - 63 - 1;
        result += b << shift;
        shift += 5;
      } while (b >= 0x1f);
      z = result >> 1;

      result = 1;
      shift = 0;
      do {
        b = encoded.charAt(index++).charCodeAt(0) - 63 - 1;
        result += b << shift;
        shift += 5;
      } while (b >= 0x1f);
      x = result >> 1;

      result = 1;
      shift = 0;
      do {
        b = encoded.charAt(index++).charCodeAt(0) - 63 - 1;
        result += b << shift;
        shift += 5;
      } while (b >= 0x1f);
      y = result >> 1;

      if (z < 0 || x < 0 || y < 0 || z > 20 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) {
        console.log('skipping ' + z + ' ' + x + ' ' + y + "\n");
        continue;
      }

      var tileCenter = mercator.ll([
        ((x + 0.5) / (1 << z)) * (256 << z),
        ((y + 0.5) / (1 << z)) * (256 << z)
      ], z);

      var filename = 'z' + z + 'x' + x + 'y' + y + '.' + format;
      var promise = renderImage(z, tileCenter[0], tileCenter[1], 0, 0, 256, 256, 1, format, filename, archive);
      renderPromises.push(promise);
    }

    output.on('close', function () {
      res.download(outputFilePath, 'tiles.zip', (err) => {
        // Delete the file after the transfer is complete
        fs.unlinkSync(outputFilePath);
      });
    });
    // output.on('end', function () {
    //   // TODO: handle it?
    // });
    // output.on('finish', function () {
    //   // TODO: handle it?
    // });
    // archive.on('warning', function (err) {
    //   // TODO: handle it?
    //   console.log(err);
    // });
    archive.on('error', function (err) {
      console.error(err);
      res.send(err);
    });

    Promise.all(renderPromises)
      .then(() => archive.finalize())
      .catch(function (reason) {
        console.error(reason);
        res.send(reason);
      });
  });

  return Promise.all([fontListingPromise, renderersReadyPromise]).then(function () {
    return app;
  });
};
