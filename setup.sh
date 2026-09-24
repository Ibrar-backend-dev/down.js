#!/bin/bash

echo "🔧 Seal Web App - Setup Script"
echo "======================================"

# Check if yt-dlp is installed
if ! command -v yt-dlp &> /dev/null; then
    echo "❌ yt-dlp is not installed."
    echo "📦 Installing yt-dlp..."

    # Try different installation methods
    if command -v apt &> /dev/null; then
        echo "🐧 Detected Ubuntu/Debian - using apt"
        sudo apt update && sudo apt install -y yt-dlp
    elif command -v brew &> /dev/null; then
        echo "🍎 Detected macOS - using brew"
        brew install yt-dlp
    elif command -v pip &> /dev/null; then
        echo "🐍 Using pip to install yt-dlp"
        pip install yt-dlp
    else
        echo "⚠️  Please install yt-dlp manually:"
        echo "   Ubuntu/Debian: sudo apt install yt-dlp"
        echo "   macOS: brew install yt-dlp"
        echo "   Other: pip install yt-dlp"
        exit 1
    fi
else
    echo "✅ yt-dlp is already installed"
fi

# Check yt-dlp version
echo "📋 yt-dlp version: $(yt-dlp --version)"

# Install Node.js dependencies
echo "📦 Installing Node.js dependencies..."
if npm install; then
    echo "✅ Dependencies installed successfully"
else
    echo "❌ Failed to install dependencies. Check your network connection."
    exit 1
fi

# Create downloads directory
mkdir -p downloads
echo "📁 Created downloads directory"

# Create .env from the example template if it doesn't exist yet
if [ ! -f .env ]; then
    cp .env.example .env
    echo "📝 Created .env from .env.example"
fi

echo ""
echo "🎉 Setup complete! You can now start the API server:"
echo "   npm run dev"
echo ""
echo "🌐 The API will be available at:"
echo "   http://localhost:5000"
echo ""
echo "🚀 Happy downloading!"
