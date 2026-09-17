.PHONY: help setup prereqs install uninstall init test lint format typecheck check

SHELL_RC ?= $(HOME)/.zshrc

help:
	@echo "Available targets:"
	@echo "  help       Show this help message"
	@echo "  setup      One-shot: install prerequisites, link jaynalerts, and install hooks"
	@echo "             Override the shell rc target with: make setup SHELL_RC=/path/to/rc"
	@echo "  prereqs    Ensure Xcode CLT, Homebrew, and bun are installed"
	@echo "  install    Link jaynalerts globally with bun link"
	@echo "  uninstall  Remove the global bun link"
	@echo "  init       Run jaynalerts init (all coding-agent integrations by default)"
	@echo "  test       Run tests"
	@echo "  lint       Run Biome checks"
	@echo "  format     Format files with Biome"
	@echo "  typecheck  Run TypeScript type checking"
	@echo "  check      Run lint, typecheck, and test"

setup: prereqs
	bun install
	bun link
	@which jaynalerts
	jaynalerts init --claude-code --opencode --pi --shell-rc "$(SHELL_RC)"

prereqs:
	@command -v xcode-select >/dev/null 2>&1 && (xcode-select -p >/dev/null 2>&1 || xcode-select --install) || true
	@command -v brew >/dev/null 2>&1 || { \
		echo "Homebrew is required. Install from https://brew.sh, then re-run make setup." >&2; \
		exit 1; \
	}
	@command -v bun >/dev/null 2>&1 || brew install bun

install:
	bun link
	which jaynalerts
	@echo "Next step: run make init"

uninstall:
	bun unlink

init:
	jaynalerts init

test:
	bun test

lint:
	bunx biome check .

format:
	bunx biome format --write .

typecheck:
	bunx tsc --noEmit

check: lint typecheck test
