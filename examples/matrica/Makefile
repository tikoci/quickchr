# matrica — Parallel Version Matrix
# Starts 4 ARM64 CHR instances (one per RouterOS channel) in parallel,
# installs zerotier + container packages, and compares output across versions.
#
# Usage:
#   make              # start all 4 instances
#   make stop         # stop all instances
#   make clean        # stop + remove all instances
#   make status       # show status of all instances
#   make diff         # compare exports across versions
#   make LITE=1 ...   # run only long-term + stable (faster, CI-friendly)
#
# Run with development build of quickchr:
#   make QUICKCHR="bun run ../../index.ts --"

QUICKCHR ?= quickchr

CHANNELS := long-term stable testing development
LITE_CHANNELS := long-term stable

ifdef LITE
ACTIVE_CHANNELS := $(LITE_CHANNELS)
else
ACTIVE_CHANNELS := $(CHANNELS)
endif

NAMES := $(foreach ch,$(ACTIVE_CHANNELS),matrica-$(subst -,,$(ch)))
PORT_LONGTERM  := 9200
PORT_STABLE    := 9210
PORT_TESTING   := 9220
PORT_DEV       := 9230

PACKAGES := zerotier,container
CONFIG   := rb5009-arm64.rsc

SSH_OPTS := -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR

port_base = $(PORT_$(shell echo $(1) | tr a-z A-Z | tr - _))

.PHONY: all start stop clean status diff bun-test py help

all: start ## Start all instances (default target)

start: ## Start all instances in parallel
	@echo "matrica: starting $(words $(ACTIVE_CHANNELS)) ARM64 CHR instances (arch=arm64)"
	@echo "  channels: $(ACTIVE_CHANNELS)"
	@$(MAKE) -j$(words $(ACTIVE_CHANNELS)) $(addprefix .start-,$(ACTIVE_CHANNELS))
	@echo ""
	@$(MAKE) status

.start-long-term:
	@$(QUICKCHR) start matrica-longterm \
	  --channel long-term \
	  --arch arm64 \
	  --port-base $(PORT_LONGTERM) \
	  --packages $(PACKAGES) \
	  2>&1 | sed 's/^/  [long-term] /'

.start-stable:
	@$(QUICKCHR) start matrica-stable \
	  --channel stable \
	  --arch arm64 \
	  --port-base $(PORT_STABLE) \
	  --packages $(PACKAGES) \
	  2>&1 | sed 's/^/  [stable] /'

.start-testing:
	@$(QUICKCHR) start matrica-testing \
	  --channel testing \
	  --arch arm64 \
	  --port-base $(PORT_TESTING) \
	  --packages $(PACKAGES) \
	  2>&1 | sed 's/^/  [testing] /'

.start-development:
	@$(QUICKCHR) start matrica-dev \
	  --channel development \
	  --arch arm64 \
	  --port-base $(PORT_DEV) \
	  --packages $(PACKAGES) \
	  2>&1 | sed 's/^/  [development] /'

stop: ## Stop all instances
	@echo "matrica: stopping instances..."
	@for name in matrica-longterm matrica-stable matrica-testing matrica-dev; do \
	  $(QUICKCHR) stop $$name 2>/dev/null && echo "  stopped $$name" || true; \
	done

clean: stop ## Stop and remove all instances
	@echo "matrica: removing instances..."
	@for name in matrica-longterm matrica-stable matrica-testing matrica-dev; do \
	  $(QUICKCHR) remove --force $$name 2>/dev/null && echo "  removed $$name" || true; \
	done

status: ## Show status of all matrica instances
	@printf "  %-24s %-8s %-14s %s\n" NAME STATUS VERSION PORTS
	@printf "  %-24s %-8s %-14s %s\n" "----" "------" "-------" "-----"
	@for name in matrica-longterm matrica-stable matrica-testing matrica-dev; do \
	  $(QUICKCHR) status $$name 2>/dev/null || printf "  %-24s %-8s\n" $$name "(not found)"; \
	done

diff: ## Upload config to each, reset, export, and show diff
	@echo "matrica: config drift check"
	@echo "  config: $(CONFIG)"
	@test -f $(CONFIG) || (echo "Error: $(CONFIG) not found" && exit 1)
	@for rec in \
	  "matrica-longterm:$(PORT_LONGTERM)" \
	  "matrica-stable:$(PORT_STABLE)" \
	  "matrica-testing:$(PORT_TESTING)" \
	  "matrica-dev:$(PORT_DEV)"; do \
	  name=$$(echo $$rec | cut -d: -f1); \
	  base=$$(echo $$rec | cut -d: -f2); \
	  ssh_port=$$(($$base + 2)); \
	  echo "  [$$name] uploading $(CONFIG)..."; \
	  scp $(SSH_OPTS) -P $$ssh_port $(CONFIG) admin@127.0.0.1:/$(CONFIG) 2>/dev/null || \
	    (echo "  [$$name] scp failed — skipping" && continue); \
	  echo "  [$$name] resetting configuration..."; \
	  curl -s -u admin: -X POST \
	    "http://127.0.0.1:$$base/rest/system/reset-configuration" \
	    -H "Content-Type: application/json" \
	    -d '{"run-after-reset":"$(CONFIG)","keep-users":"yes","skip-backup":"yes"}' \
	    >/dev/null 2>&1 || true; \
	  sleep 5; \
	  echo "  [$$name] waiting for reboot..."; \
	  for _i in $$(seq 1 60); do \
	    curl -sf -u admin: "http://127.0.0.1:$$base/rest/system/resource" >/dev/null 2>&1 && break; \
	    sleep 2; \
	  done; \
	  echo "  [$$name] exporting..."; \
	  ssh $(SSH_OPTS) -p $$ssh_port admin@127.0.0.1 ":export" > /tmp/matrica-$$name.rsc 2>/dev/null || \
	    echo "  [$$name] export failed — ssh may not be in PATH"; \
	done
	@echo "Exports collected in /tmp/matrica-*.rsc"
	@if command -v diff >/dev/null 2>&1; then \
	  echo ""; \
	  echo "long-term → stable:"; \
	  diff -U 0 /tmp/matrica-matrica-longterm.rsc /tmp/matrica-matrica-stable.rsc 2>/dev/null | \
	    grep '^[+-]' | grep -v '^---' | grep -v '^+++' | head -20 || echo "  (no diff or missing export)"; \
	fi

bun-test: ## Run matrica bun:test suite
	@QUICKCHR_INTEGRATION=1 bun test matrica.test.ts

bun-test-lite: ## Run lite (2-channel) bun:test suite
	@QUICKCHR_INTEGRATION=1 MATRICA_LITE=1 bun test matrica.test.ts

py: ## Run matrica.py (Python CLI version)
	python3 matrica.py

py-lite: ## Run matrica.py with --lite flag (2 channels, CI-friendly)
	python3 matrica.py --lite

py-no-cleanup: ## Run matrica.py and leave instances running (useful for restraml schema extraction)
	python3 matrica.py --no-cleanup

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
