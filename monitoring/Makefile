ALERTS_DIR := prometheus/alerts

.PHONY: test-alerts lint-alerts help

## test-alerts: validate all Prometheus alert rule files with promtool
test-alerts:
	@echo "==> Checking Prometheus alert rules..."
	@for f in $(ALERTS_DIR)/*.yml; do \
		echo "  promtool check rules $$f"; \
		promtool check rules "$$f" || exit 1; \
	done
	@echo "==> All alert rules OK"

## lint-alerts: alias for test-alerts
lint-alerts: test-alerts

help:
	@grep -E '^## ' Makefile | sed 's/## //'
