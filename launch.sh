#!/bin/bash
# Signal Rush — Launch script
# Run this from the Z440 desktop terminal
cd /home/hive/signal-rush
ECONOMY_URL=http://127.0.0.1:8720 node src/cli/index.js
echo ""
echo "Game exited. Press Enter to close."
read
