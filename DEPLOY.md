# W SHOP - Deploy to Render (Free)

## Quick Deployment

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/wshop.git
   git push -u origin main
   ```

2. **Deploy to Render**
   - Go to https://dashboard.render.com
   - Click "New +"
   - Select "Web Service"
   - Connect your GitHub repository
   - Build Command: `npm install`
   - Start Command: `node server/index.js`
   - Add Environment Variable: `PUBLIC_URL` = your URL (e.g. https://wshop-xxx.onrender.com)
   - Click "Deploy Web Service"

3. **New QR Codes**
   - After deployment, get your public URL (e.g. https://wshop-xxx.onrender.com)
   - Login to admin panel: https://wshop-xxx.onrender.com/admin.html
   - Go to Settings → set PUBLIC_URL to your domain
   - Go to QR Codes → download new QR codes
   - Print them

The store will work from any network in the world.

**Local test:**
```bash
npm start
```
Open http://localhost:3000
