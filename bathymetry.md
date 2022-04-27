# All About Bathymetry

The `bathymetry.json` style supports bathymetry in meters (`bathymetry.mbtiles`) and feet (`bathymetry-us.mbtiles`) .

The style expects MBTiles sources to include a layer named, `contours` with attributes `INDEX` and `ELEV`/`ELEV_F`.

## MBTiles Attribute Requirements

### bathymetry.mbtiles 

 - `ELEV`  is an integer of the depth in meters
 - `INDEX` is an integer in the set: `1, 2, 5, 10` that is the GCD of `ELEV` (e.g. `ELEV=20 INDEX=10`, `ELEV=8 INDEX=2`, `ELEV=13 INDEX=1`)


### bathymetry-us.mbtiles
 - `ELEV_F`  is an integer of the depth in feet
 - `INDEX` is an integer in the set: `1, 2, 5, 10` that is the GCD of `ELEV` (e.g. `ELEV=20 INDEX=10`, `ELEV=8 INDEX=2`, `ELEV=13 INDEX=1`)

 ---

## Adding New Data

### Preparing Data

Usually incoming bathymetry is in the form of `.SHP` files. The data usually needs to be cleaned up a little bit.

1. Remove shapes where the depth is 0. We don't want to keep shorelines because they'll clash with the existing waterbody boundaries and they're not really useful.
2. Remove unused attributes (names, ids, etc.)
3. Rename depth attribute to `ELEV` or `ELEV_F` depending on units
4. Add `INDEX` column. (Using QGIS )

Optionally you can "smooth" the incoming lines. Depending on the data you may or may not have to do that.

---

### Converting to MBTiles



1. Export prepared `.shp` files to `.geojson` with `EPSG:4326` projection. (And if possible disable the z-axis and set the precision to 5)
2. Use [`tippecanoe`](https://github.com/mapbox/tippecanoe) to convert to `.mbtiles`: e.g. `tippecanoe -l contours --minimum-zoom=6 -o output.mbtiles input.geojson`
3. Merge newley created `.mbtiles` into `bathymetry.mbtiles` or `bathymetry-us.mbtiles`: e.g. `tile-join -o bathymetry.mbtiles bathymetry.mbtiles input.mbtiles`

---

### Release

1. Upload the newly joined `bathymetry.mbtiles` / `bathymetry-us.mbtiles` to the tileserver
2. Restart the Docker container running the server: `./docker-stop.sh && ./docker-build.sh && ./docker-run.sh`

