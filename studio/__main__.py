import uvicorn

from .config import Settings
from .main import create_app

settings = Settings()
uvicorn.run(create_app(settings), host=settings.host, port=settings.port)
