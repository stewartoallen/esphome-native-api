## regenerate JS protobuf library

```bash
$ brew install protoc protoc-gen-js
$ wget -c https://raw.githubusercontent.com/esphome/aioesphomeapi/main/aioesphomeapi/api_options.proto
$ wget -c https://raw.githubusercontent.com/esphome/aioesphomeapi/main/aioesphomeapi/api.proto
$ protoc --js_out=import_style=commonjs:lib/protoc api_options.proto api.proto
```
