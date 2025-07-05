const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
// Temporary: Allows all origins for debugging. Revert to specific origins for production!
app.use(cors()); 
app.use(express.json());

const ODOO_URL = process.env.ODOO_URL;
const API_KEY = process.env.API_KEY;

// Global variable to store the Odoo session cookie.
// IMPORTANT: For a multi-user production environment, this would need
// a more robust session management solution (e.g., per-client session storage).
// For this single-client proxy demo, it's sufficient.
let odooSessionCookie = null; 

// Middleware to verify API key
const verifyApiKey = (req, res, next) => {
  const clientKey = req.headers['x-api-key'];
  if (!clientKey || clientKey !== API_KEY) {
    console.warn('Unauthorized access attempt: Invalid API key');
    return res.status(403).json({ error: 'Unauthorized: Invalid API key' });
  }
  next();
};

// Login Endpoint (using /web/session/authenticate)
app.post('/api/login', verifyApiKey, async (req, res) => {
  try {
    if (!req.body.odooConfig || !req.body.odooConfig.db || 
        !req.body.odooConfig.username || !req.body.odooConfig.password) {
      console.error('Login error: Missing required fields in odooConfig');
      return res.status(400).json({ error: 'Missing required fields for Odoo login' });
    }

    const { db, username, password } = req.body.odooConfig;

    console.log('--- Odoo Login Request DEBUG (web/session/authenticate) ---');
    console.log('Target Odoo URL:', `${ODOO_URL}/web/session/authenticate`);
    // IMPORTANT: Do NOT log the password in production. For debugging only.
    console.log('Request Payload (excluding password):', JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { db, login: username, password: '********' },
        id: req.body.id || Math.floor(Math.random() * 1000)
    }, null, 2));

    const response = await axios.post(
      `${ODOO_URL}/web/session/authenticate`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: { db, login: username, password },
        id: req.body.id || Math.floor(Math.random() * 1000)
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10000
      }
    );

    console.log('--- Odoo Login Response DEBUG (web/session/authenticate) ---');
    console.log('Odoo Response Status:', response.status);
    console.log('Odoo Response Data:', JSON.stringify(response.data, null, 2));

    // Capture the Set-Cookie header from Odoo's login response
    if (response.headers['set-cookie']) {
      odooSessionCookie = response.headers['set-cookie'];
      console.log('Captured Odoo Session Cookie:', odooSessionCookie);
    } else {
      console.warn('No Set-Cookie header found in Odoo login response.');
    }

    if (response.data && response.data.result && response.data.result.uid) {
      return res.json({ result: response.data.result.uid });
    }

    const error = response.data && response.data.error;
    const errorMsg = (error && error.message) || "Authentication failed";
    console.error('Odoo login failed:', errorMsg, 'Details:', error);
    return res.status(error.response ? error.response.status : 500).json({
        error: "Authentication failed",
        details: errorMsg
    });

  } catch (error) {
    console.error('Login endpoint error:', error.message);
    if (error.response) {
        console.error('Login endpoint Odoo Error Response Data:', JSON.stringify(error.response.data, null, 2));
        return res.status(error.response.status).json({ error: error.response.data.error || 'Odoo login error' });
    } else {
        return res.status(500).json({ error: error.message || 'Internal Server Error during login' });
    }
  }
});

// Odoo API Endpoint (for execute_kw calls - using /web/dataset/call_kw)
app.post('/api/odoo', verifyApiKey, async (req, res) => {
    try {
        // Frontend sends: odooConfig, model, method, args, kwargs, uid
        const { odooConfig, model, method, args, kwargs, uid } = req.body; 

        if (!ODOO_URL) {
            console.error('ODOO_URL environment variable is not set in Glitch .env');
            return res.status(500).json({ error: 'Server configuration error: Odoo URL not set.' });
        }

        if (!uid) {
            console.error('Odoo API call error: User ID (UID) is missing.');
            return res.status(400).json({ error: 'User ID (UID) is required for Odoo API calls.' });
        }

        const odooPayload = {
            jsonrpc: "2.0",
            method: "call",
            params: {
                model: model, // e.g., 'product.template'
                method: method, // e.g., 'search_read'
                args: args, // Positional arguments (e.g., domain)
                kwargs: kwargs, // Keyword arguments (e.g., fields, limit)
            },
            id: req.body.id || Math.floor(Math.random() * 1000)
        };

        console.log('--- Odoo Proxy Request DEBUG (web/dataset/call_kw) ---');
        console.log('Target Odoo URL:', `${ODOO_URL}/web/dataset/call_kw`);
        console.log('Request Payload:', JSON.stringify(odooPayload, null, 2));

        const odooHeaders = {
            'Content-Type': 'application/json',
        };

        // Add the captured session cookie to the request headers
        if (odooSessionCookie) {
            // Note: When sending to Odoo, use the 'Cookie' header, not 'Set-Cookie'
            odooHeaders['Cookie'] = odooSessionCookie; 
            console.log('Sending Odoo Session Cookie with call_kw:', odooSessionCookie);
        } else {
            console.warn('No Odoo session cookie available for call_kw request. Session might be expired or not established.');
            // If no session cookie, Odoo will likely return a "Session expired" error, which is fine for now.
        }

        const odooResponse = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, odooPayload, {
            headers: odooHeaders, // Use the headers object with the cookie
            timeout: 10000
        });

        console.log('--- Odoo Proxy Response DEBUG (web/dataset/call_kw) ---');
        console.log('Odoo Response Status:', odooResponse.status);
        console.log('Odoo Response Data:', JSON.stringify(odooResponse.data, null, 2));

        res.json(odooResponse.data); // Forward Odoo's response
    } catch (error) {
        console.error('Odoo API endpoint error:', error.message);
        if (error.response) {
            console.error('Odoo API endpoint Odoo Error Response Data:', JSON.stringify(error.response.data, null, 2));
            return res.status(error.response.status).json({ error: error.response.data.error || 'Odoo API error' });
        } else {
            return res.status(500).json({ error: error.message || 'Internal Server Error during Odoo API call' });
        }
    }
});

// Root route - fixes "Cannot GET /"
app.get('/', (req, res) => {
    res.send(`
        <h1>Odoo Proxy Server Running</h1>
        <p>Available endpoints:</p>
        <ul>
            <li>POST /api/login</li>
            <li>POST /api/odoo</li>
        </ul>
        <p>Check the Glitch logs for startup messages and Odoo API interactions.</p>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Odoo login endpoint: ${ODOO_URL}/web/session/authenticate`);
    console.log(`Odoo API endpoint: ${ODOO_URL}/web/dataset/call_kw`);
});