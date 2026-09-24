#!/bin/bash

echo "🚀 Starting Seal Web App API"
echo "========================"

# Function to cleanup on exit
cleanup() {
    echo "🛑 Shutting down server..."
    pkill -f "node --env-file-if-exists=.env server/index.js" 2>/dev/null
    exit 0
}

# Set up cleanup trap
trap cleanup SIGINT SIGTERM

# Kill any existing process on port 5000
echo "🧹 Cleaning up existing processes..."
lsof -ti:5000 | xargs kill -9 2>/dev/null || true

# Wait a moment for cleanup
sleep 1

echo "🔧 Starting API server..."
npm run dev &

echo ""
echo "✅ Seal Web App API is starting up!"
echo "🔗 API: http://localhost:5000"
echo ""
echo "Press Ctrl+C to stop the server"

# Wait for user to stop
wait
