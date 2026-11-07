# In-app update of the Docker installation: git pull, image rebuild, restart of the
# studio container (server.py). Docker CLI with the compose and buildx plugins.
FROM docker:28.5.1-cli
RUN apk add --no-cache git python3
COPY server.py /updater/server.py
CMD ["python3", "-u", "/updater/server.py"]
