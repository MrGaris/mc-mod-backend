# MC Mod Compiler Backend

Free Minecraft mod compilation server for [MC Mod Generator](https://github.com).

## Deploy to Render.com (free, no card)

1. Fork this repo
2. Go to [render.com](https://render.com) → sign up with GitHub (no card!)
3. New → Web Service → connect this repo
4. Settings:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Plan:** Free
5. Deploy!

Your API URL: `https://mc-mod-compiler.onrender.com`

## API

### `GET /`
Health check.

### `POST /compile`
Compile a mod and return the JAR file.

**Request body:**
```json
{
  "modId": "my_mod",
  "modName": "MyMod",
  "loader": "NeoForge",
  "mcVersion": "1.21.1",
  "files": {
    "src/main/java/com/modgen/mymod/MyMod.java": "package com.modgen...",
    "src/main/resources/META-INF/neoforge.mods.toml": "..."
  }
}
```

**Response:** Binary JAR file

## Notes
- First build takes ~5-10 minutes (downloads Gradle + Minecraft deps ~500MB)
- Subsequent builds: ~30-60 seconds (deps cached)
- Render free tier sleeps after 15min inactivity — first request after sleep takes ~30s to wake up
