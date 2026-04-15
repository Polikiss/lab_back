# probe-bridge-oracle

Off-chain oracle: **Polkadot Hub EVM** `ProbeBridgeToken.lock` → **Stellar Soroban** `mint`; обратное направление `POST /mint-from-stellar`.

Публичный репозиторий бэка: **[github.com/Polikiss/lab_back](https://github.com/Polikiss/lab_back)**.  
Исходник в монорепо: [probe-coin](https://github.com/is-dapps-platforms-y26/probe-coin) (`bridge-oracle`).

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

Файл **`.env` в git не коммитится** — на хостинге всё задаётся в **Variables / Environment**.

**Обязательно добавьте хотя бы** (скопируйте из `.env.example`):

| Переменная | Пример (Polkadot Hub testnet) |
|------------|-------------------------------|
| **`EVM_RPC_URL`** | `https://eth-rpc-testnet.polkadot.io/` |

Без **`EVM_RPC_URL`** сервис сразу падает с сообщением: *«Задайте EVM_RPC_URL в .env или переменных окружения»*.

Дальше в панели хостинга продублируйте остальное из `.env.example`: `EVM_CHAIN_ID`, `VOTE_TOKEN_ADDRESS`, `STELLAR_*`, `ORACLE_EVM_PRIVATE_KEY` и т.д.

- **Build:** `npm ci && npm run build`
- **Start:** `npm start` На Railway/Render порт задаёт платформа (**`PORT`**); локально можно оставить `PORT=8080` в Variables или не задавать — тогда подставится дефолт из кода.

Публичные эндпоинты для интеграции со Stellar:

- `POST /mint-from-stellar` — JSON: `stellarTxHash`, `evmRecipient`, `amount`
- `GET /status/stellar/:stellarTxHash`
- `GET /health`

CORS: `Access-Control-Allow-Origin: *`

## Требования

- Node.js **>= 20**
