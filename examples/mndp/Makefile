# mndp — receive RouterOS MNDP broadcasts from a CHR on the host
#
# A caller gives the CHR a second NIC on QEMU's TCP `socket` netdev
# (socket:connect:<port>), runs a host TCP server, and parses the guest's L2
# frames to extract MNDP (UDP/5678) neighbor-discovery announcements.
#
# The actual capture (a TCP server + length-prefixed L2 frame parsing) can't be
# expressed in shell, so the Makefile delegates it to the bun:test or the Python
# script — the same split documented in ../../docs/mndp.md.
#
# Usage:
#   make capture      # run the Python listener (boots a CHR, prints one MNDP record)
#   make bun-test     # run the bun:test (asserts L2 discovery vs REST)
#   make py           # alias for capture
#   make clean        # remove the example machine if left behind
#   make help
#
# Run against a dev build of quickchr (no global install):
#   make QUICKCHR="bun run ../../src/cli/index.ts --" capture

QUICKCHR ?= quickchr
NAME     := mndp-example
CHANNEL  ?= stable
ARCH     ?= auto

.PHONY: capture py bun-test clean help

capture: ## Boot a CHR and print one captured MNDP record (Python CLI driver)
	python3 mndp.py --channel $(CHANNEL) --arch $(ARCH) --quickchr "$(QUICKCHR)"

py: capture ## Alias for `capture`

py-no-cleanup: ## Capture, but leave the CHR running for inspection
	python3 mndp.py --channel $(CHANNEL) --arch $(ARCH) --quickchr "$(QUICKCHR)" --no-cleanup

bun-test: ## Run the bun:test (library API; asserts MNDP vs REST)
	@QUICKCHR_INTEGRATION=1 bun test mndp.test.ts

clean: ## Remove the example machine if a run left it behind
	@$(QUICKCHR) stop $(NAME) 2>/dev/null || true
	@$(QUICKCHR) remove $(NAME) 2>/dev/null && echo "removed $(NAME)" || true

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
