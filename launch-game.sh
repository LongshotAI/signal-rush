#!/bin/bash
# Signal Rush — AI HUNT launcher
cd /home/hive/signal-rush
export ECONOMY_URL=http://127.0.0.1:8720
echo ""
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║          S I G N A L   R U S H   //   A I   H U N T        ║"
echo "  ║                    Terminal Arcade                           ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo ""
node src/cli/index.js
echo ""
echo "Game exited. Press Enter to close."
read
