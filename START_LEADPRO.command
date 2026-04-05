#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "Starting LeadPro..."
echo ""

# Check for node
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Opening download page..."
  open "https://nodejs.org"
  echo "Install Node.js, then double-click START_LEADPRO.command again."
  read -p "Press Enter to close..."
  exit 1
fi

echo "✅ Node.js found: $(node --version)"
echo ""
echo "✅ Starting server on http://localhost:3000"
echo ""

# Open browser after short delay
sleep 1.5 && open "http://localhost:3000/app" &

node server.js
