# RWA Tokenization — Backend API Service

> **University Research Prototype:** Node.js + Express.js (ES Modules) + MongoDB / In-Memory Failover + ethers.js v6  
> **Service Port:** `5001` (Default) | REST API for Real-World Asset Metadata & Deed Verification

---

## 1. Overview

The backend service is responsible for:
- Serving cached asset descriptions, high-resolution imagery, and property specifications.
- Generating SHA-256 cryptographic fingerprints for submitted property title deeds.
- Managing the asset onboarding lifecycle (`Pending` $\rightarrow$ `Approved` $\rightarrow$ `Tokenized`).
- Operating a zero-failure repository (MongoDB Atlas connected with automatic in-memory failover for offline viva demonstrations).

> ⚠️ **Authoritative State Rule:** As specified in the research design, MongoDB is never treated as the source of truth for token balances, shareholder equity, or votes. Token ownership is strictly queried directly from `AssetToken.sol` on the blockchain.

---

## 2. Installation & Setup

Ensure Node.js (v20 or v22) is installed.

```bash
cd asset-tokenization-backend
npm install
```

### Environment Configuration (`.env`)
Create or edit `.env` in `asset-tokenization-backend/`:

```dotenv
PORT=5001
FRONTEND_URL=http://localhost:5173
# Required for authentication, KYC and compliance; only asset repositories have a fallback.
MONGO_URI=mongodb://localhost:27017/rwa_tokenization
```

If MongoDB cannot connect, authentication, KYC and compliance return HTTP 503
with `DATABASE_UNAVAILABLE`. The asset fallback does not contain user accounts
or KYC records. Check the configured database host, network/firewall access,
and credentials, then restart the backend. For a local database, run MongoDB
and use `mongodb://127.0.0.1:27017/rwa_tokenization`.

Marketplace listings require a running blockchain RPC and a deployed
`TokenMarketplace` at the address in `src/contracts/deployedContracts.json`.
After resetting the local chain, redeploy contracts and refresh the deployment
configuration. An absent contract returns `MARKETPLACE_NOT_DEPLOYED` (HTTP 503).

---

## 3. How to Run

### Start the Server
```bash
node src/server.js
```
or with automatic restart:
```bash
npx nodemon src/server.js
```

**Console Output:**
```text
====================================================
🚀 Asset Tokenization Backend running on port 5001
📡 Health endpoint: http://localhost:5001/api/health
🏢 Assets endpoint: http://localhost:5001/api/assets
====================================================
```

---

## 4. REST API Endpoints Reference

### Health & Status
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Service status, timestamp, and database connection state |

### Asset Management
| Method | Route | Description | Request Body / Params |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/assets` | Get list of all registered real-world properties | Supports query filters |
| `GET` | `/api/assets/:id` | Get specific asset details and deed hash | `id`: Asset ID |
| `POST` | `/api/assets` | Register a new real-world property | Form fields (`name`, `symbol`, `valuationLKR`, `totalShares`, `documentContent`, etc.) |
| `PATCH` | `/api/assets/:id/status`| Update status post-blockchain confirmation | `{ "status": "Approved" \| "Tokenized", "txHash": "0x..." }` |
| `GET` | `/api/assets/:id/verify-deed`| Verify SHA-256 deed integrity against blockchain | Computes cryptographic digest |

### Sample POST Request Payload (`/api/assets`):
```json
{
  "name": "Colombo Oceanfront Penthouse",
  "symbol": "COP-01",
  "propertyType": "Residential Real Estate",
  "location": "Marine Drive, Colombo 03, Sri Lanka",
  "description": "Luxury 3-bedroom penthouse with direct Indian Ocean panoramic views.",
  "valuationLKR": 15000000,
  "totalShares": 1500,
  "imageUrl": "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80",
  "deedIdentifier": "DEED-LK-WP-2026-9812A",
  "issuerWallet": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "documentContent": "DEED-LK-WP-2026-9812A-Colombo Oceanfront Penthouse-Marine Drive"
}
```

---

## 5. Contract Synchronization

Whenever smart contracts are redeployed via `npx hardhat run scripts/deploy.js --network localhost`, the deployment script automatically writes the active addresses and ABIs to:
```text
asset-tokenization-backend/src/contracts/deployedContracts.json
```
This keeps the backend in continuous synchronization with the active Hardhat local node.
