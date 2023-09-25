#!/bin/bash

if [ $# -eq 0 ]; then
	echo "Usage: $0 <port>"
	exit 1
fi

PORT=$1

docker stop tileserver-$PORT
exit $?
