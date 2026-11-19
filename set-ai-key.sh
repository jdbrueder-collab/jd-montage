#!/bin/zsh
# Hinterlegt den Claude-API-Schlüssel für die KI-Funktion, ohne dass er im Verlauf landet.
cd "$(dirname "$0")"
read -s "K?API-Schlüssel einfügen (beginnt mit sk-ant-api) und Enter drücken: "
echo
case "$K" in
  sk-ant-api*) supabase secrets set ANTHROPIC_API_KEY="$K" --yes && echo "✓ Schlüssel hinterlegt. Du kannst dieses Fenster schließen." ;;
  *) echo "✗ Das ist kein API-Schlüssel (muss mit sk-ant-api beginnen). Bitte unter console.anthropic.com → API Keys einen erstellen." ;;
esac
unset K
