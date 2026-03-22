const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const { execSync, spawn } = require('child_process');
const os       = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Auto-install Java if missing ─────────────────────────────────────
function ensureJava() {
  try {
    execSync('java -version 2>&1');
    console.log('[java] Already installed:', execSync('java -version 2>&1').toString().split('\n')[0]);
    return true;
  } catch {
    console.log('[java] Not found, installing...');
    try {
      execSync('apt-get update -qq && apt-get install -y openjdk-21-jdk-headless 2>&1', {
        stdio: 'inherit', timeout: 5 * 60 * 1000
      });
      console.log('[java] Installed successfully');
      return true;
    } catch (e) {
      console.error('[java] Install failed:', e.message);
      return false;
    }
  }
}

// Run Java install on startup
ensureJava();

// ── Health check ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MC Mod Compiler', java: getJavaVersion() });
});

// ── Groq proxy (keeps API key server-side) ────────────────────────────
app.post('/generate', async (req, res) => {
  const { system, user } = req.body;
  if (!system || !user) return res.status(400).json({ error: 'Missing system or user' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not set on server' });

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   }
        ],
        max_tokens: 8000,
        temperature: 0.2
      })
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /compile
// Body: { modId, modName, loader, mcVersion, files: { "path": "content" } }
app.post('/compile', async (req, res) => {
  const { modId, modName, loader, mcVersion, files } = req.body;

  if (!modId || !files || typeof files !== 'object') {
    return res.status(400).json({ error: 'Missing modId or files' });
  }

  const workDir = path.join(os.tmpdir(), 'mcmod_' + Date.now() + '_' + modId);

  try {
    console.log(`[compile] Starting: ${modId} (${loader} ${mcVersion})`);

    // Write all project files
    writeProjectFiles(workDir, modId, modName, loader, mcVersion, files);

    // Make gradlew executable
    const gradlew = path.join(workDir, 'gradlew');
    if (fs.existsSync(gradlew)) fs.chmodSync(gradlew, '755');

    // Run gradle build
    console.log(`[compile] Running gradle build in ${workDir}`);
    await runGradle(workDir);

    // Find the JAR
    const libsDir = path.join(workDir, 'build', 'libs');
    const jars = fs.readdirSync(libsDir).filter(f => f.endsWith('.jar') && !f.includes('sources') && !f.includes('javadoc'));

    if (jars.length === 0) throw new Error('No JAR found after build');

    const jarPath = path.join(libsDir, jars[0]);
    const jarData = fs.readFileSync(jarPath);

    console.log(`[compile] Success: ${jars[0]} (${jarData.length} bytes)`);

    res.set({
      'Content-Type':        'application/java-archive',
      'Content-Disposition': `attachment; filename="${jars[0]}"`,
      'Content-Length':      jarData.length,
      'X-Mod-Id':            modId,
    });
    res.send(jarData);

  } catch (err) {
    console.error(`[compile] Error:`, err.message);
    res.status(500).json({
      error: 'Compilation failed',
      details: err.message.slice(0, 2000)
    });
  } finally {
    // Cleanup
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Write all project files ──────────────────────────────────────────
function writeProjectFiles(workDir, modId, modName, loader, mcVersion, generatedFiles) {
  fs.mkdirSync(workDir, { recursive: true });

  const isFabric = loader === 'Fabric';
  const neoV = mcVersion === '1.21.1' ? '21.1.80' : mcVersion === '1.20.4' ? '20.4.237' : '21.1.80';
  const pkg = `com.modgen.${modId.replace(/[^a-z0-9]/g, '')}`;

  // gradle-wrapper.properties
  writeFile(workDir, 'gradle/wrapper/gradle-wrapper.properties', `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists`);

  // gradlew
  writeFile(workDir, 'gradlew', `#!/bin/sh
DIRNAME=$(cd "$(dirname "$0")" && pwd)
exec java -jar "$DIRNAME/gradle/wrapper/gradle-wrapper.jar" "$@"`);
  fs.chmodSync(path.join(workDir, 'gradlew'), '755');

  // settings.gradle
  writeFile(workDir, 'settings.gradle',
    isFabric ?
`pluginManagement {
    repositories {
        maven { url = 'https://maven.fabricmc.net/' }
        mavenCentral()
        gradlePluginPortal()
    }
}
rootProject.name = "${modId}"` :
`pluginManagement {
    repositories {
        maven { url = 'https://maven-central.storage.googleapis.com' }
        mavenCentral()
        gradlePluginPortal()
        maven { url = 'https://maven.neoforged.net/releases' }
    }
}
plugins { id 'org.gradle.toolchains.foojay-resolver-convention' version '0.8.0' }
rootProject.name = "${modId}"`);

  // gradle.properties
  writeFile(workDir, 'gradle.properties',
    isFabric ?
`minecraft_version=${mcVersion}
yarn_mappings=${mcVersion}+build.1
loader_version=0.16.10
fabric_version=0.114.1+1.21.1
java_version=21
maven_group=${pkg}
mod_id=${modId}
mod_name=${modName}
mod_version=1.0.0
mod_authors=ModGen
mod_description=Generated mod
org.gradle.jvmargs=-Xmx2G
org.gradle.daemon=false` :
`minecraft_version=${mcVersion}
neo_version=${neoV}
java_version=21
maven_group=${pkg}
mod_id=${modId}
mod_name=${modName}
mod_version=1.0.0
mod_authors=ModGen
mod_description=Generated mod
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=512m
org.gradle.daemon=false
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.configuration-cache=false`);

  // build.gradle
  writeFile(workDir, 'build.gradle',
    isFabric ?
`plugins {
    id 'fabric-loom' version '1.9-SNAPSHOT'
    id 'maven-publish'
}
version = project.mod_version
group = project.maven_group
base { archivesName = project.mod_id }
java.toolchain.languageVersion = JavaLanguageVersion.of(project.java_version.toInteger())
repositories { mavenCentral() }
dependencies {
    minecraft "com.mojang:minecraft:\${project.minecraft_version}"
    mappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"
    modImplementation "net.fabricmc:fabric-loader:\${project.loader_version}"
    modImplementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}"
}
tasks.withType(JavaCompile).configureEach { options.encoding = 'UTF-8' }` :
`plugins {
    id 'java-library'
    id 'maven-publish'
    id 'net.neoforged.gradle.userdev' version '7.0.163'
}
version = project.mod_version
group = project.maven_group
base { archivesName = project.mod_id }
java.toolchain.languageVersion = JavaLanguageVersion.of(project.java_version.toInteger())
repositories {
    maven { url = 'https://maven-central.storage.googleapis.com' }
    mavenCentral()
}
dependencies { implementation "net.neoforged:neoforge:\${neo_version}" }
tasks.withType(ProcessResources).configureEach {
    var props = [minecraft_version:minecraft_version,neo_version:neo_version,
        mod_id:mod_id,mod_name:mod_name,mod_version:mod_version,
        mod_authors:mod_authors,mod_description:mod_description]
    inputs.properties props
    filesMatching(['META-INF/neoforge.mods.toml']) { expand props + [project:project] }
}
tasks.withType(JavaCompile).configureEach { options.encoding = 'UTF-8' }`);

  // Write all AI-generated files
  for (const [filePath, content] of Object.entries(generatedFiles)) {
    writeFile(workDir, filePath, content);
  }

  // Default config if missing
  const hasFabric = Object.keys(generatedFiles).some(f => f.includes('fabric.mod.json'));
  const hasToml   = Object.keys(generatedFiles).some(f => f.includes('neoforge.mods.toml'));

  if (isFabric && !hasFabric) {
    writeFile(workDir, 'src/main/resources/fabric.mod.json', JSON.stringify({
      schemaVersion: 1, id: modId, version: '1.0.0', name: modName,
      description: 'Generated mod', authors: ['ModGen'], environment: '*',
      entrypoints: { main: [`${pkg}.${modName}`] },
      depends: { fabricloader: '>=0.14.0', fabric: '*', minecraft: mcVersion }
    }, null, 2));
  }
  if (!isFabric && !hasToml) {
    writeFile(workDir, 'src/main/resources/META-INF/neoforge.mods.toml',
`modLoader="javafml"
loaderVersion="[4,)"
license="All Rights Reserved"
[[mods]]
modId="${modId}"
version="\${mod_version}"
displayName="\${mod_name}"
description="\${mod_description}"
[[dependencies.${modId}]]
modId="neoforge"
type="required"
versionRange="[${neoV},)"
ordering="NONE"
side="BOTH"
[[dependencies.${modId}]]
modId="minecraft"
type="required"
versionRange="[${mcVersion},)"
ordering="NONE"
side="BOTH"`);
  }
}

function writeFile(base, relPath, content) {
  const full = path.join(base, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// ── Run Gradle ───────────────────────────────────────────────────────
function runGradle(workDir) {
  return new Promise((resolve, reject) => {
    const gradlew = path.join(workDir, 'gradlew');
    const cmd     = fs.existsSync(gradlew) ? gradlew : 'gradle';
    const proc    = spawn(cmd, ['build', '--no-daemon', '--parallel', '--no-scan', '-x', 'test'], {
      cwd: workDir,
      env: { ...process.env, GRADLE_USER_HOME: path.join(os.tmpdir(), 'gradle_cache') },
      timeout: 8 * 60 * 1000 // 8 min timeout
    });

    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });
    proc.stderr.on('data', d => { out += d.toString(); process.stderr.write(d); });

    proc.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`Gradle exited with code ${code}\n\n${out.slice(-3000)}`));
    });
    proc.on('error', reject);
  });
}

function getJavaVersion() {
  try { return execSync('java -version 2>&1').toString().split('\n')[0]; }
  catch { return 'java not found'; }
}

app.listen(PORT, () => console.log(`MC Mod Compiler running on port ${PORT}`));
