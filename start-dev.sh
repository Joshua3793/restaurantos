#!/bin/bash
# Start the dev server with environment variables loaded from .env
# This ensures vars like ANTHROPIC_API_KEY aren't overridden by the parent environment

cd "$(dirname "$0")"

# Load .env into the process, overriding any inherited empty values
set -o allexport
source .env
set +o allexport

exec node_modules/.bin/next dev
