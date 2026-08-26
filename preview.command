#!/bin/bash
# Double-click this in Finder to pull the latest data and open the archive
# in your browser — equivalent to `cd scraper && npm run preview`, just
# without having to open a terminal and type it.
cd "$(dirname "$0")/scraper" || exit 1
npm run preview
