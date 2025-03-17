docker buildx build --platform linux/arm64 -t josefelixh/firefly-iii-ai-categorize:$1 --load .
docker push josefelixh/firefly-iii-ai-categorize:$1