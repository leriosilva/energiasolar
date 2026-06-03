# Imagem com Node + Python para rodar o app e o agente de extracao de PDFs.
FROM node:20-bookworm-slim

# Dependencias do sistema: Python e venv
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ambiente Python isolado com pdfplumber
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Dependencias Node
COPY package*.json ./
RUN npm install --omit=dev

# Codigo da aplicacao
COPY . .

ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/venv/bin/python3
EXPOSE 3000
CMD ["npm", "start"]
