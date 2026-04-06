# Supabase IoT Dashboard (Cloud Version)

This is a separate version of your dashboard designed for **cloud deployment** and **24/7 logging**.

## 1. Supabase Setup (Database)
1.  Go to [Supabase](https://supabase.com/) and create a free project.
2.  Open the **SQL Editor** in the side menu.
3.  Click "New Query" and paste the contents of `schema.sql`. Run it.
4.  Go to **Project Settings** -> **API**.
    *   Copy your `Project URL`
    *   Copy your `anon` public key
    *   Copy your `service_role` secret key (for the bridge only)

## 2. Bridge Setup (24/7 Logging)
The bridge ensures data is saved even when your dashboard tab is closed.
1.  Navigate to the `bridge/` folder.
2.  Create a `.env` file (copy from `.env.example`).
3.  Fill in your `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
4.  Install dependencies: `npm install mqtt @supabase/supabase-js dotenv`
5.  Run it: `node index.js` (You can keep this running on any computer/server).

## 3. Frontend Setup (Dashboard)
1.  Navigate to the `frontend/` folder.
2.  Create a `.env` file (copy from `.env.example`).
    *   **Note**: Use `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3.  Install dependencies: `npm install`
4.  Run it: `npm run dev`

## Deployment
*   **Frontend**: Push the `frontend` folder to GitHub and connect it to **Vercel** or **Netlify**.
*   **Bridge**: You can host the `bridge` script on **Render.io** (Free Tier) or **Fly.io** as a background process.

---

### Features kept from previous version:
*   **Same MQTT Topic**: `iaq/palakkad/data`
*   **Same Visual Design**: Glassmorphism, vibrant cards, and pulse animations.
*   **Same Analytics**: Historical date filtering (now powered by PostgreSQL).
*   **NEW**: Live data syncs across all devices automatically via Supabase Realtime.
