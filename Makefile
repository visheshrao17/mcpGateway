CLUSTER ?= urumi
RELEASE ?= urumi
NAMESPACE ?= urumi-platform
# A unique tag per build changes the pod template, so `make deploy` always rolls out the new image.
ifndef TAG
TAG := $(shell date +%Y%m%d%H%M%S)
endif
VALUES ?= values/values-local.yaml

.PHONY: cluster image deploy redeploy llm-secret up test dod seed clean status

cluster:
	k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create $(CLUSTER) -p "80:80@loadbalancer" -p "443:443@loadbalancer" --wait

image:
	docker build -t urumi/app:$(TAG) .
	k3d image import urumi/app:$(TAG) -c $(CLUSTER)

deploy:
	helm upgrade --install $(RELEASE) charts/urumi -n $(NAMESPACE) --create-namespace -f $(VALUES) --set image.tag=$(TAG) --wait --wait-for-jobs --timeout 10m

llm-secret:
	scripts/llm-secret.sh $(NAMESPACE)

up: cluster image llm-secret deploy

redeploy: image deploy

status:
	kubectl get pods,pvc,ingress -A -l app.kubernetes.io/part-of=urumi

test:
	npm test

dod:
	node scripts/dod-test.ts

seed:
	node scripts/seed-demo.ts

clean:
	k3d cluster delete $(CLUSTER)
