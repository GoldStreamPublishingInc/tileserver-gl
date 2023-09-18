# Angler's Atlas Specific Details

This Angler's Atlas fork includes a couple of changes specific to anglersatlas.com and MyCatch.

- `GET /styles/{id}/staticmap`
  - Takes in "Google" style query parameters and gives back a static map image.

- `POST /styles/{id}/bundle`
  - Expects a POST body: `encoded={encodedString}` where the encoded string are the `zxy` tiles to be rendered and returned zipped.
  - The tiles are encoded using [Google's Encoded Polyline Algorithm Format](https://developers.google.com/maps/documentation/utilities/polylinealgorithm) without doing the offset for subsequent values, just straight zxy values. Look to `TilePacker::_generateTilePack` in the `anglers-atlas-v3` repo.
