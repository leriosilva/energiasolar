# Plataforma de Faturas de Energia — Lério & Silva

Sistema web full-stack para gestão de faturas de energia, com controle de **múltiplos titulares**, **diversas instalações por titular** e **importação de dados via Excel**. Pronto para deploy no **Railway** a partir de um repositório **GitHub**.

## O que o sistema faz

- **Titulares**: cadastro de clientes (pessoa física ou jurídica), com documento, contato e observações.
- **Instalações**: cada titular pode ter várias unidades consumidoras (UCs). O código da instalação corresponde ao número que aparece na fatura.
- **Upload de Excel**: importa planilhas (.xlsx, .xls, .csv) com as faturas. As instalações são criadas/atualizadas automaticamente, e faturas repetidas (mesmo titular + instalação + mês) são atualizadas em vez de duplicadas.
- **Análise**: dashboard com KPIs, gráficos mês a mês (consumo, valor, custo/kWh, saldo × injetada), consolidação por instalação e tabela analítica. Filtros por múltiplos titulares, múltiplas instalações, ano e bandeira. A visualização dos dashboards pode ser **Consolidada** (todas as instalações somadas) ou **Por instalação** (uma série por UC, para comparação).

## Arquitetura

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Express |
| Banco | PostgreSQL (plugin gerenciado do Railway) |
| Parsing Excel | SheetJS (`xlsx`) |
| Upload | Multer |
| Frontend | HTML + CSS + JavaScript (sem build) + Chart.js |

```
.
├── server.js            # API REST + serve o frontend
├── src/
│   ├── db.js            # conexão Postgres + migração das tabelas
│   └── parsing.js       # normalização das linhas do Excel
├── public/              # frontend (index.html, app.js, styles.css)
├── package.json
├── railway.json         # config de build/deploy do Railway
├── Procfile
└── .env.example
```

As tabelas (`titulares`, `instalacoes`, `faturas`) são criadas automaticamente na primeira execução.

---

## Passo a passo: subir no GitHub + Railway

### 1. Enviar para o GitHub

```bash
git init
git add .
git commit -m "Plataforma de faturas de energia LS"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git
git push -u origin main
```

### 2. Criar o projeto no Railway

1. Acesse https://railway.app e crie um projeto novo com **"Deploy from GitHub repo"**.
2. Selecione o repositório que você acabou de enviar.
3. No mesmo projeto, clique em **"+ New" → "Database" → "Add PostgreSQL"**.
   - O Railway injeta a variável `DATABASE_URL` no serviço da aplicação automaticamente.
4. Confirme que o serviço da app está usando o comando `npm start` (já definido em `railway.json` e no `Procfile`).
5. Gere um domínio público em **Settings → Networking → Generate Domain**.

Pronto. Ao abrir o domínio, o sistema cria as tabelas e exibe a interface.

> **SSL**: o `db.js` ativa SSL automaticamente quando detecta um host do Railway. Se necessário, defina a variável `PGSSL=true`.

---

## Rodar localmente

Pré-requisito: Node 18+ e um PostgreSQL acessível.

```bash
cp .env.example .env      # ajuste a DATABASE_URL
npm install
npm start                 # http://localhost:3000
```

---

## Layout da planilha de upload

A primeira linha do Excel deve conter os cabeçalhos abaixo (acentos e maiúsculas/minúsculas são tolerados). Baixe um modelo pronto na própria tela de upload (botão **"Baixar modelo (.xlsx)"**) ou em `GET /api/template`.

| Coluna | Obrigatória | Observação |
|---|---|---|
| Titular | Sim* | *Opcional se você escolher um titular no seletor da tela |
| Instalação | Sim | Código/UC da unidade consumidora |
| Mês | Sim | `MM/AAAA` (01/2025) ou `MMM/AA` (JAN/25) |
| Apelido | Não | Nome amigável da instalação |
| Leitura Atual | Não | |
| Vencimento | Não | |
| Consumo Faturado (kWh) | Não | Formato BR aceito (1.234,000) |
| # Dias | Não | |
| Total a pagar | Não | Aceita `R$ 1.234,56` |
| Bandeira | Não | |
| Saldo atualizado de energia em kWh | Não | |
| Energia injetada no mês em kWh | Não | |
| Status | Não | |

---

## Endpoints da API

| Método | Rota | Descrição |
|---|---|---|
| GET/POST | `/api/titulares` | Listar / criar titulares |
| PUT/DELETE | `/api/titulares/:id` | Editar / excluir titular |
| POST | `/api/titulares/merge` | Unificar titulares (`{destino_id, origem_ids:[...]}`) |
| GET/POST | `/api/instalacoes` | Listar (`?titular_id=`) / criar instalação |
| PUT/DELETE | `/api/instalacoes/:id` | Editar / excluir instalação |
| GET | `/api/faturas` | Listar faturas (`?titular_id=1,2` `&instalacao_id=5,6` — aceita múltiplos) |
| DELETE | `/api/faturas/:id` | Excluir fatura |
| DELETE | `/api/titulares/:id/faturas` | Limpar todas as faturas de um titular |
| DELETE | `/api/instalacoes/:id/faturas` | Limpar todas as faturas de uma instalação |
| POST | `/api/upload/excel` | Importar planilha (multipart; campo `substituir=true` sobrescreve) |
| POST | `/api/faturas/lote` | Inserir faturas em lote (JSON) |
| GET | `/api/template` | Baixar modelo de planilha |
| GET | `/api/health` | Healthcheck |

---

© Lério & Silva — Contabilidade Estratégica.
