#!/bin/bash

SERVER=vpn
USER=root
BASEDIR=$(dirname "$0")

ssh vpn -t "mkdir -p /var/www/parser-bot"
rsync -rzv "$BASEDIR//" "$USER"@"$SERVER":/var/www/parser-bot
