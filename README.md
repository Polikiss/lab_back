# probe-bridge-oracle

Off-chain oracle: **Polkadot Hub EVM** `ProbeBridgeToken.lock` → **Stellar Soroban** `mint`; обратное направление `POST /mint-from-stellar`.

Исходный код синхронизирован из монорепо [probe-coin](https://github.com/is-dapps-platforms-y26/probe-coin) (каталог `bridge-oracle`).

## Быстрый старт локально

```bash
cp .env.example .env
# заполнить .env
npm ci
npm run build
npm start
```

Проверка: `GET http://127.0.0.1:8080/health` (или порт из `PORT`).

## Деплой (Railway / Render / VPS)

- **Build:** `npm ci && npm run build`
- **Start:** `npm start`
- Переменные окружения — как в `.env.example` (секреты только в панели хостинга, не в git).

Публичные эндпоинты для интеграции со Stellar:

- `POST /mint-from-stellar` — JSON: `stellarTxHash`, `evmRecipient`, `amount`
- `GET /status/stellar/:stellarTxHash`
- `GET /health`

CORS: `Access-Control-Allow-Origin: *`

## Требования

- Node.js **>= 20**
