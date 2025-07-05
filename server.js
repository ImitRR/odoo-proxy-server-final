const express = require('express');
const cors = require('cors'); // Make sure cors is imported
const axios = require('axios');
require('dotenv').config();

const app = express();

// Explicitly configure CORS to allow your GitHub Pages origin
// IMPORTANT: Replace 'https://imitrr.github.io' with your exact GitHub Pages URL if it changes.
const allowedOrigins = ['https://imitrr.github.io']; 

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        // or if the origin is in our allowed list.
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true // Important for sending/receiving cookies/session info
}));

app.use(express.json());

// These are loaded from Replit Secrets (Environment Variables)
const ODOO_URL = process.env.ODOO_URL; // This is the base Odoo URL you configured
const API_KEY = process.env.API_KEY;   // This is your proxy's API key

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
    // Ensure all necessary Odoo configuration details are provided in the request body
    if (!req.body.odooConfig || !req.body.odooConfig.db || 
        !req.body.odooConfig.username || !req.body.odooConfig.password || !req.body.odooConfig.url) {
        console.error('Missing Odoo configuration in login request body.');
        return res.status(400).json({ error: 'Missing Odoo configuration (url, db, username, password)' });
    }

    const { url, db, username, password } = req.body.odooConfig; // Destructure Odoo config from request body

    const authPayload = {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        db: db,
        login: username,
        password: password,
      },
      id: 1,
    };

    // --- DEBUGGING LOG ---
    console.log('--- Odoo Proxy Request DEBUG (web/session/authenticate) ---');
    console.log('Target Odoo URL:', `${url}/web/session/authenticate`);
    console.log('Auth Payload:', JSON.stringify(authPayload, null, 2));
    // --- END DEBUGGING LOG ---

    const odooResponse = await axios.post(`${url}/web/session/authenticate`, authPayload, {
      headers: {
        'Content-Type': 'application/json',
      },
      // Ensure cookies are handled for session management
      withCredentials: true,
      timeout: 10000 // 10 second timeout
    });

    // Capture the session cookie from Odoo's response
    const setCookieHeader = odooResponse.headers['set-cookie'];
    if (setCookieHeader) {
        // Extract only the cookie value (before the first ';') and join them
        odooSessionCookie = setCookieHeader.map(cookie => cookie.split(';')[0]).join('; ');
        console.log('Odoo Session Cookie Captured:', odooSessionCookie ? 'Yes' : 'No');
    } else {
        console.warn('No Odoo session cookie received in login response.');
    }

    console.log('--- Odoo Proxy Response DEBUG (web/session/authenticate) ---');
    console.log('Odoo Response Status:', odooResponse.status);
    console.log('Odoo Response Data:', JSON.stringify(odooResponse.data, null, 2));

    if (odooResponse.data.result && odooResponse.data.result.uid) {
      res.json({ result: odooResponse.data.result.uid }); // Return the UID on successful login
    } else if (odooResponse.data.error) {
      console.error('Odoo authentication error:', odooResponse.data.error);
      return res.status(401).json({ error: odooResponse.data.error.message || 'Odoo authentication failed' });
    } else {
      return res.status(500).json({ error: 'Unexpected Odoo login response' });
    }

  } catch (error) {
    console.error('Login endpoint error:', error.message);
    if (error.response) {
        console.error('Login endpoint Odoo Error Response Data:', JSON.stringify(error.response.data, null, 2));
        return res.status(error.response.status).json({ error: error.response.data.error || 'Odoo login API error' });
    } else {
        return res.status(500).json({ error: error.message || 'Internal Server Error during Odoo login API call' });
    }
  }
});

// Generic Odoo API Endpoint (using /web/dataset/call_kw)
app.post('/api/odoo', verifyApiKey, async (req, res) => {
    try {
        if (!odooSessionCookie) {
            console.warn('No Odoo session cookie available. Client needs to log in first.');
            return res.status(401).json({ error: 'Unauthorized: No active Odoo session. Please log in.' });
        }
        // Ensure Odoo URL is provided in the request body from the client
        if (!req.body.odooConfig || !req.body.odooConfig.url) { 
            console.error('Missing Odoo URL in Odoo call request body.');
            return res.status(400).json({ error: 'Missing Odoo URL in request body' });
        }

        // Destructure Odoo API call parameters from the request body
        const { model, method, args, kwargs } = req.body; 
        const odooUrl = req.body.odooConfig.url; // Use odooConfig.url for the actual Odoo URL

        const callKwPayload = {
            jsonrpc: '2.0',
            method: 'call',
            params: {
                model: model,
                method: method,
                args: args,
                kwargs: kwargs,
            },
            id: 1,
        };

        // --- DEBUGGING LOG ---
        console.log('--- Odoo Proxy Request DEBUG (web/dataset/call_kw) ---');
        console.log('Target Odoo URL:', `${odooUrl}/web/dataset/call_kw`);
        console.log('Call_kw Payload:', JSON.stringify(callKwPayload, null, 2));
        console.log('Using Odoo Session Cookie:', odooSessionCookie ? 'Yes' : 'No');
        // --- END DEBUGGING LOG ---

        const odooResponse = await axios.post(`${odooUrl}/web/dataset/call_kw`, callKwPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': odooSessionCookie // Send the captured session cookie
            },
            withCredentials: true,
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
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the proxy at: http://localhost:${PORT}`); // This will be Replit's internal URL
});
