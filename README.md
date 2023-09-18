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
- bathymetry-us.mbtiles

```bash
./docker-stop.sh && ./docker-build.sh && ./docker-run.sh
```

`monitrc`
```
check program tileserver with path /home/renderaccount/tileserver-gl/docker-check.sh
        if status != 0 then alert
```

`/etc/httpd/conf.d/ssl.conf` (on iWeb CentOS machine)

![tileserver-gl](https://cloud.githubusercontent.com/assets/59284/18173467/fa3aa2ca-7069-11e6-86b1-0f1266befeb6.jpeg)

# TileServer GL
[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/maptiler/tileserver-gl/pipeline.yml)](https://github.com/maptiler/tileserver-gl/actions/workflows/pipeline.yml)
[![Docker Hub](https://img.shields.io/badge/docker-hub-blue.svg)](https://hub.docker.com/r/maptiler/tileserver-gl/)

Vector and raster maps with GL styles. Server-side rendering by MapLibre GL Native. Map tile server for MapLibre GL JS, Android, iOS, Leaflet, OpenLayers, GIS via WMTS, etc.

Download vector tiles from [OpenMapTiles](https://data.maptiler.com/downloads/planet/).
## Getting Started with Node

Make sure you have Node.js version **14.20.0** or above installed. Node 18 is recommended. (running `node -v` it should output something like `v18.x.x`). Running without docker requires [Native dependencies](https://maptiler-tileserver.readthedocs.io/en/latest/installation.html#npm) to be installed first.

Install `tileserver-gl` with server-side raster rendering of vector tiles with npm. 

```bash
npm install -g tileserver-gl
```

Once installed, you can use it like the following examples.

using a mbtiles file
```bash
wget https://github.com/maptiler/tileserver-gl/releases/download/v1.3.0/zurich_switzerland.mbtiles
tileserver-gl --mbtiles zurich_switzerland.mbtiles
[in your browser, visit http://[server ip]:8080]
```

using a config.json + style + mbtiles file
```bash
wget https://github.com/maptiler/tileserver-gl/releases/download/v1.3.0/test_data.zip
unzip test_data.zip
tileserver-gl
[in your browser, visit http://[server ip]:8080]
```

Alternatively, you can use the `tileserver-gl-light` npm package instead, which is pure javascript, does not have any native dependencies, and can run anywhere, but does not contain rasterization on the server side made with Maplibre GL Native.

## Getting Started with Docker

An alternative to npm to start the packed software easier is to install [Docker](https://www.docker.com/) on your computer and then run from the tileserver-gl directory

Example using a mbtiles file
```bash
wget https://github.com/maptiler/tileserver-gl/releases/download/v1.3.0/zurich_switzerland.mbtiles
docker run --rm -it -v $(pwd):/data -p 8080:8080 maptiler/tileserver-gl --mbtiles zurich_switzerland.mbtiles
[in your browser, visit http://[server ip]:8080]
```

Example using a config.json + style + mbtiles file
```bash
wget https://github.com/maptiler/tileserver-gl/releases/download/v1.3.0/test_data.zip
unzip test_data.zip
docker run --rm -it -v $(pwd):/data -p 8080:8080 maptiler/tileserver-gl
[in your browser, visit http://[server ip]:8080]
```

Example using a different path
```bash
docker run --rm -it -v /your/local/config/path:/data -p 8080:8080 maptiler/tileserver-gl
```
replace '/your/local/config/path' with the path to your config file


Alternatively, you can use the `maptiler/tileserver-gl-light` docker image instead, which is pure javascript, does not have any native dependencies, and can run anywhere, but does not contain rasterization on the server side made with Maplibre GL Native.

## Getting Started with Linux cli

Test from command line
```bash
wget https://github.com/maptiler/tileserver-gl/releases/download/v1.3.0/test_data.zip
unzip -q test_data.zip -d test_data
xvfb-run --server-args="-screen 0 1024x768x24" npm test
```

Run from command line
```bash
xvfb-run --server-args="-screen 0 1024x768x24" node .
```

## Documentation

You can read the full documentation of this project at https://maptiler-tileserver.readthedocs.io/.

## Alternative

Discover MapTiler Server if you need a [map server with easy setup and user-friendly interface](https://www.maptiler.com/server/).

