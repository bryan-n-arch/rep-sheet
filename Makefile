.PHONY: create push deploy open url

# One-time: create a new "Rep Sheet" Google Sheet with a bound Apps Script project.
# clasp would overwrite apps-script/ with starter files, so clone into a temp dir
# and point .clasp.json at apps-script/ afterwards.
create:
	@test ! -f .clasp.json || (echo ".clasp.json already exists; project was already created" && exit 1)
	clasp create --type sheets --title "Rep Sheet" --rootDir .clasp-create
	rm -rf .clasp-create
	python3 -c "import json; p='.clasp.json'; c=json.load(open(p)); c['rootDir']='apps-script'; json.dump(c, open(p, 'w'), indent=2)"

push:
	clasp push --force

# Push code and update the web app. The first run creates the deployment and
# saves its id so the URL stays the same on every later deploy.
deploy: push
	@if [ -f .deployment-id ]; then \
		clasp deploy -i "$$(cat .deployment-id)" -d "$$(date '+%F %T')"; \
	else \
		clasp deploy -d "$$(date '+%F %T')" | tee /dev/stderr | grep -o 'AKfy[A-Za-z0-9_-]*' | head -1 > .deployment-id; \
		test -s .deployment-id || (echo "Could not read deployment id from clasp output" && rm -f .deployment-id && exit 1); \
	fi
	@$(MAKE) --no-print-directory url

url:
	@echo "Web app: https://script.google.com/macros/s/$$(cat .deployment-id)/exec"

open:
	clasp open-container
