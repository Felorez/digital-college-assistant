FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 BOT_DATA_DIR=/data
WORKDIR /app
COPY telegram-bot/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY telegram-bot/ ./
RUN mkdir -p /data
CMD ["python", "-u", "college_bot.py"]
