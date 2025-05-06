#!/bin/bash

which protoc || brew install protoc
which protoc-gen-js || brew install protoc-gen-js
mkdir -p tmp
cd tmp
rm api.proto api_options.proto

wget -c https://raw.githubusercontent.com/esphome/aioesphomeapi/main/aioesphomeapi/api.proto
wget -c https://raw.githubusercontent.com/esphome/aioesphomeapi/main/aioesphomeapi/api_options.proto

protoc --js_out=import_style=commonjs:../lib/protoc api_options.proto api.proto
