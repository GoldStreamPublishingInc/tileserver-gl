# AA TileServer GL

This AnglersAtlas :tm: fork includes an extra endpoint that provides a zipped folder of rendered tiles.
It's expects a string of the tiles to render in the format `zoom x y` and then encoded using [Google's Encoded Polyline Algorithm Format](https://developers.google.com/maps/documentation/utilities/polylinealgorithm).

Endpoint:
- `POST /styles/{id}/bundle`
  - Expected POST body: `encoded={encodedString}`

## Installation/Run instructions:

You need to include the `mbtiles` files in this root directory. Basic tiles/styles can be downloaded from OpenMapTiles with an account.

Expected tiles include:
- [osm.mbtiles](https://openmaptiles.com/downloads/tileset/osm/)
- [satellite.mbtiles](https://openmaptiles.com/downloads/tileset/satellite/)
- bathymetry.mbtiles

```bash
docker build --force-rm -t tileserver .
```
```bash
docker run --rm -it -p 8080:80 -v $(pwd):/data tileserver --verbose
```

## How to generate Bathymetry mbtiles (or how I (Clayton) generated them)

There's a shape (`.shp`) file with bathymetry lines around Vancouver Island, provided to me by Jamie.

I had to use QGIS to process the data and remove coastline polylines (because they didn't match the land shapes 100%) and make the depth attribute positive (negative by default) so when rendering them they make sense (20m rendered on bathymetry lines on the tiles is standard, compared to -20m). 

Export the fixed shape file as GeoJSON with `EPSG:4326` coordinate system.

Then I used [tippecanoe](https://github.com/mapbox/tippecanoe) to convert the GeoJSON file into an `mbtiles` file.

```bash
tippecanoe -o bathymetry.mbtiles -z18 bathymetry.json
```

That's it!

![tileserver-gl](https://cloud.githubusercontent.com/assets/59284/18173467/fa3aa2ca-7069-11e6-86b1-0f1266befeb6.jpeg)

# TileServer GL
[![Build Status](https://travis-ci.org/klokantech/tileserver-gl.svg?branch=master)](https://travis-ci.org/klokantech/tileserver-gl)
[![Docker Hub](https://img.shields.io/badge/docker-hub-blue.svg)](https://hub.docker.com/r/klokantech/tileserver-gl/)

Vector and raster maps with GL styles. Server side rendering by Mapbox GL Native. Map tile server for Mapbox GL JS, Android, iOS, Leaflet, OpenLayers, GIS via WMTS, etc.

## Get Started

Make sure you have Node.js version **6** installed (running `node -v` it should output something like `v6.11.3`).

Install `tileserver-gl` with server-side raster rendering of vector tiles with npm

```bash
npm install -g tileserver-gl
```

Now download vector tiles from [OpenMapTiles](https://openmaptiles.org/downloads/).

```bash
curl -o zurich_switzerland.mbtiles https://[GET-YOUR-LINK]/extracts/zurich_switzerland.mbtiles
```

Start `tileserver-gl` with the downloaded vector tiles.

```bash
tileserver-gl zurich_switzerland.mbtiles
```

Alternatively, you can use the `tileserver-gl-light` package instead, which is pure javascript (does not have any native dependencies) and can run anywhere, but does not contain rasterization on the server side made with MapBox GL Native.

## Using Docker

An alternative to npm to start the packed software easier is to install [Docker](http://www.docker.com/) on your computer and then run in the directory with the downloaded MBTiles the command:

```bash
docker run --rm -it -v $(pwd):/data -p 8080:80 klokantech/tileserver-gl
```

This will download and start a ready to use container on your computer and the maps are going to be available in webbrowser on localhost:8080.

On laptop you can use [Docker Kitematic](https://kitematic.com/) and search "tileserver-gl" and run it, then drop in the 'data' folder the MBTiles.

## Documentation

You can read full documentation of this project at http://tileserver.readthedocs.io/.
