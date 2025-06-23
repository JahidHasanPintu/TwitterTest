const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');

const app = express();
const port = process.env.PORT || 8000; // Changed to 8000 to match your callback URLs

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Session configuration
app.use(session({
  secret: 'your-session-secret-change-this',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Twitter API credentials - replace with your actual credentials
const TWITTER_CLIENT_ID = 'your_client_id';
const TWITTER_CLIENT_SECRET = 'your_client_secret';

// Use environment variable for redirect URI or default to one of your configured URLs
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:8000/api/v1/x/login/social-media';

// Determine the correct callback path based on the redirect URI
const getCallbackPath = () => {
  const url = new URL(REDIRECT_URI);
  return url.pathname;
};

// Generate code verifier and challenge for PKCE
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Main page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Twitter Image Uploader</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .container { background: #f5f5f5; padding: 30px; border-radius: 10px; }
            button { background: #1da1f2; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
            button:hover { background: #0d8bd9; }
            .upload-form { margin-top: 20px; padding: 20px; background: white; border-radius: 5px; }
            input[type="file"] { margin: 10px 0; }
            textarea { width: 100%; height: 100px; margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
            .status { margin: 20px 0; padding: 10px; border-radius: 5px; }
            .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Twitter Image Uploader</h1>
            
            ${req.session.accessToken ? `
                <div class="status success">✅ Connected to Twitter!</div>
                
                <div class="upload-form">
                    <h3>Upload Image to Twitter</h3>
                    <form action="/upload" method="post" enctype="multipart/form-data">
                        <div>
                            <label>Select Image:</label><br>
                            <input type="file" name="image" accept="image/*" required>
                        </div>
                        <div>
                            <label>Tweet Text:</label><br>
                            <textarea name="text" placeholder="What's happening?"></textarea>
                        </div>
                        <button type="submit">Post to Twitter</button>
                    </form>
                </div>
                
                <button onclick="location.href='/logout'" style="background: #dc3545; margin-top: 20px;">Disconnect</button>
            ` : `
                <p>Connect your Twitter account to start uploading images.</p>
                <button onclick="location.href='/auth'">Connect with Twitter</button>
            `}
        </div>
    </body>
    </html>
  `);
});

// Start Twitter OAuth flow
app.get('/auth', (req, res) => {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  
  // Store code verifier in session
  req.session.codeVerifier = codeVerifier;
  
  const authUrl = `https://twitter.com/i/oauth2/authorize?` +
    `response_type=code&` +
    `client_id=${TWITTER_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=tweet.read%20tweet.write%20users.read&` +
    `state=state&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256`;
  
  res.redirect(authUrl);
});

// Handle OAuth callback - dynamic route based on redirect URI
app.get(getCallbackPath(), async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.redirect('/?error=authorization_denied');
  }
  
  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://api.twitter.com/2/oauth2/token', {
      code,
      grant_type: 'authorization_code',
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: req.session.codeVerifier
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64')}`
      }
    });
    
    req.session.accessToken = tokenResponse.data.access_token;
    req.session.refreshToken = tokenResponse.data.refresh_token;
    
    res.redirect('/');
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// Upload image to Twitter
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.session.accessToken) {
    return res.redirect('/');
  }
  
  if (!req.file) {
    return res.redirect('/?error=no_file_selected');
  }
  
  try {
    // Read the uploaded file
    const imageBuffer = fs.readFileSync(req.file.path);
    
    // First, let's try the v2 approach with base64 encoding
    const base64Image = imageBuffer.toString('base64');
    
    try {
      // Try v1.1 media upload with proper form data
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('media_data', base64Image);
      
      const mediaUploadResponse = await axios.post(
        'https://upload.twitter.com/1.1/media/upload.json',
        formData,
        {
          headers: {
            'Authorization': `Bearer ${req.session.accessToken}`,
            ...formData.getHeaders()
          }
        }
      );
      
      const mediaId = mediaUploadResponse.data.media_id_string;
      
      // Step 2: Create tweet with media
      const tweetData = {
        text: req.body.text || '',
        media: {
          media_ids: [mediaId]
        }
      };
      
      const tweetResponse = await axios.post(
        'https://api.twitter.com/2/tweets',
        tweetData,
        {
          headers: {
            'Authorization': `Bearer ${req.session.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Upload Success</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
                .container { background: #f5f5f5; padding: 30px; border-radius: 10px; text-align: center; }
                .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; padding: 20px; border-radius: 5px; margin: 20px 0; }
                button { background: #1da1f2; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; margin: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="success">
                    <h2>✅ Image posted successfully!</h2>
                    <p>Tweet ID: ${tweetResponse.data.data.id}</p>
                </div>
                <button onclick="location.href='/'">Upload Another</button>
                <button onclick="window.open('https://twitter.com/home', '_blank')">View on Twitter</button>
            </div>
        </body>
        </html>
      `);
      
    } catch (mediaError) {
      console.error('Media upload error:', mediaError.response?.data || mediaError.message);
      
      // If media upload fails, try creating a text-only tweet
      if (req.body.text) {
        console.log('Attempting text-only tweet...');
        const textTweetResponse = await axios.post(
          'https://api.twitter.com/2/tweets',
          { text: req.body.text },
          {
            headers: {
              'Authorization': `Bearer ${req.session.accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
              <title>Partial Success</title>
              <style>
                  body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
                  .container { background: #f5f5f5; padding: 30px; border-radius: 10px; text-align: center; }
                  .warning { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; padding: 20px; border-radius: 5px; margin: 20px 0; }
                  button { background: #1da1f2; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; margin: 10px; }
              </style>
          </head>
          <body>
              <div class="container">
                  <div class="warning">
                      <h2>⚠️ Text posted, but image upload failed</h2>
                      <p>Tweet ID: ${textTweetResponse.data.data.id}</p>
                      <p>Error: ${mediaError.response?.data?.detail || mediaError.message}</p>
                  </div>
                  <button onclick="location.href='/'">Try Again</button>
              </div>
          </body>
          </html>
        `);
      } else {
        throw mediaError;
      }
    }
    
  } catch (error) {
    console.error('Upload error:', error.response?.data || error.message);
    
    // Clean up uploaded file
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Upload Error</title>
          <style>
              body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
              .container { background: #f5f5f5; padding: 30px; border-radius: 10px; text-align: center; }
              .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; padding: 20px; border-radius: 5px; margin: 20px 0; }
              button { background: #1da1f2; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
          </style>
      </head>
      <body>
          <div class="container">
              <div class="error">
                  <h2>❌ Upload failed</h2>
                  <p>Error: ${error.response?.data?.detail || error.message}</p>
              </div>
              <button onclick="location.href='/'">Try Again</button>
          </div>
      </body>
      </html>
    `);
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

app.listen(port, () => {
  console.log(`Twitter Image Uploader running at http://localhost:${port}`);
  console.log(`Using redirect URI: ${REDIRECT_URI}`);
  console.log(`Callback path: ${getCallbackPath()}`);
  console.log('Make sure to update TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET with your actual credentials');
  console.log('\nAvailable routes:');
  console.log(`- Main page: http://localhost:${port}/`);
  console.log(`- Auth: http://localhost:${port}/auth`);
  console.log(`- Callback: http://localhost:${port}${getCallbackPath()}`);
});

module.exports = app;