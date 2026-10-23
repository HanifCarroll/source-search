#!/usr/bin/env python3
"""Stable launcher for the document maintenance module."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'src'))
from maintenance.documents.cli import main
if __name__=='__main__':main()
