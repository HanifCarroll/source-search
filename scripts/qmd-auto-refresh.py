#!/usr/bin/python3
"""Stable launcher for existing refresh jobs."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'src'))
from maintenance.refresh import main
if __name__=='__main__':main()
