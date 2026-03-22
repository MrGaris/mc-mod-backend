const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { execSync, spawn } = require('child_process');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// startup check
try { console.log('[java]',   execSync('java -version 2>&1').toString().split('\n')[0]); } catch { console.error('[java] not found'); }
try { console.log('[gradle]', execSync('gradle --version 2>&1').toString().split('\n').find(l=>l.startsWith('Gradle'))); } catch { console.error('[gradle] not found'); }

app.get('/', (req, res) => {
  let java='?', gradle='?';
  try { java   = execSync('java -version 2>&1').toString().split('\n')[0]; } catch {}
  try { gradle = execSync('gradle --version 2>&1').toString().split('\n').find(l=>l.startsWith('Gradle'))||'?'; } catch {}
  res.json({ status:'ok', service:'MC Mod Compiler', java, gradle });
});

// ── Version config ────────────────────────────────────────────────────
function getVersionConfig(loader, mcVersion) {
  const neoMap = {
    '1.21.4':'21.4.20','1.21.3':'21.3.3','1.21.1':'21.1.80','1.21':'21.0.167',
    '1.20.6':'20.6.119','1.20.4':'20.4.237','1.20.2':'20.2.88',
  };
  const fabApiMap = {
    '1.21.1':'0.114.1+1.21.1','1.21':'0.100.8+1.21','1.20.4':'0.97.0+1.20.4',
    '1.20.2':'0.91.0+1.20.2','1.20.1':'0.92.2+1.20.1','1.19.4':'0.87.2+1.19.4','1.18.2':'0.77.0+1.18.2',
  };
  const isFabric = loader === 'Fabric';
  return {
    isFabric,
    neoV:      neoMap[mcVersion]    || '21.1.80',
    fabApiV:   fabApiMap[mcVersion] || '0.114.1+1.21.1',
    fabLoader: '0.16.10',
    // fabric-loom 1.9-SNAPSHOT requires Gradle 8.11; NeoForge works on 8.10.2
    gradleV:   isFabric ? '8.11' : '8.10.2',
  };
}

// ── OpenRouter AI ─────────────────────────────────────────────────────
async function callAI(sys, usr) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+key,
               'HTTP-Referer':'https://mc-mod-generator.com', 'X-Title':'MC Mod Generator' },
    body: JSON.stringify({ model:'qwen/qwen3-coder-480b-a35b:free',
      messages:[{role:'system',content:sys},{role:'user',content:usr}],
      max_tokens:16000, temperature:0.3 }),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.error?.message||'OpenRouter HTTP '+r.status); }
  const d = await r.json();
  return (d.choices?.[0]?.message?.content||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
}

// ── Generate ──────────────────────────────────────────────────────────
app.post('/generate', async (req, res) => {
  const {system,user} = req.body;
  if (!system||!user) return res.status(400).json({error:'Missing system or user'});
  const t = Date.now();
  try {
    const content = await callAI(system, user);
    console.log(`[generate] Done in ${((Date.now()-t)/1000).toFixed(1)}s`);
    res.json({ choices:[{message:{content}}] });
  } catch(err) { console.error('[generate] Error:', err.message); res.status(500).json({error:err.message}); }
});

// ── Compile with AI auto-fix loop ─────────────────────────────────────
app.post('/compile', async (req, res) => {
  const {modId,modName,loader,mcVersion,files} = req.body;
  if (!modId||!files) return res.status(400).json({error:'Missing modId or files'});

  const MAX = 4;
  let currentFiles = {...files};
  let workDir = null, lastError = '';

  for (let attempt=1; attempt<=MAX; attempt++) {
    if (workDir) { try { fs.rmSync(workDir,{recursive:true,force:true}); } catch {} }
    workDir = path.join(os.tmpdir(), `mcmod_${Date.now()}_${modId}_a${attempt}`);

    try {
      console.log(`[compile] Attempt ${attempt}/${MAX}: ${modId} (${loader} ${mcVersion})`);
      writeProjectFiles(workDir, modId, modName, loader, mcVersion, currentFiles);
      await runGradle(workDir, loader, mcVersion);

      const libsDir = path.join(workDir,'build','libs');
      const jars = fs.readdirSync(libsDir).filter(f=>f.endsWith('.jar')&&!f.includes('sources')&&!f.includes('javadoc'));
      if (!jars.length) throw new Error('No JAR found after build');

      const jarData = fs.readFileSync(path.join(libsDir,jars[0]));
      console.log(`[compile] ✅ Success on attempt ${attempt}: ${jars[0]}`);
      res.set({'Content-Type':'application/java-archive','Content-Disposition':`attachment; filename="${jars[0]}"`,'Content-Length':jarData.length,'X-Attempts':String(attempt)});
      res.send(jarData);
      try { fs.rmSync(workDir,{recursive:true,force:true}); } catch {}
      return;

    } catch(err) {
      lastError = err.message;
      console.error(`[compile] ❌ Attempt ${attempt} FAILED:`, lastError.slice(0,200));
      if (attempt===MAX) break;
      console.log(`[compile] 🤖 AI fixing (attempt ${attempt})...`);
      try { currentFiles = await aiFixErrors(currentFiles, lastError, loader, mcVersion); }
      catch(e) { console.error('[compile] AI fix failed:', e.message); break; }
    }
  }
  try { if (workDir) fs.rmSync(workDir,{recursive:true,force:true}); } catch {}
  res.status(500).json({error:'Compilation failed after AI fixes', details:lastError.slice(0,3000)});
});

// ── AI error fixer ────────────────────────────────────────────────────
async function aiFixErrors(files, errorLog, loader, mcVersion) {
  const javaFiles = Object.entries(files).filter(([p])=>p.endsWith('.java'))
    .map(([p,c])=>`// FILE: ${p}\n${c}`).join('\n\n---\n\n');
  const errorLines = errorLog.split('\n')
    .filter(l=>/error:|ERROR|FAILED|exception|Cannot find/i.test(l)).slice(0,80).join('\n');

  const sys = `You are a Minecraft mod compiler error fixer for ${loader} ${mcVersion}.
Fix ALL compilation errors. Output ONLY corrected Java files:
// FILE: src/main/java/path/ClassName.java
[corrected java code]
Rules: fix every error, keep same functionality, use only real ${loader} ${mcVersion} APIs, output ALL Java files.`;
  const usr = `BUILD ERRORS:\n${errorLines}\n\nLOG:\n${errorLog.slice(-2000)}\n\nSOURCE:\n${javaFiles}`;

  const raw = await callAI(sys, usr);
  const fixed = parseFiles(raw);
  if (!Object.keys(fixed).length) throw new Error('AI returned no files');
  return {...files, ...fixed};
}

function parseFiles(raw) {
  const out = {};
  const parts = raw.split(/\/\/\s*FILE:\s*/);
  for (let i=1;i<parts.length;i++) {
    const nl = parts[i].indexOf('\n'); if (nl===-1) continue;
    const fp = parts[i].slice(0,nl).trim();
    const c  = parts[i].slice(nl+1).trim().replace(/^```[a-z]*\n?/i,'').replace(/\n?```\s*$/i,'').trim();
    if (fp&&c) out[fp]=c;
  }
  return out;
}

// ── Write project files ───────────────────────────────────────────────
function writeProjectFiles(workDir, modId, modName, loader, mcVersion, generatedFiles) {
  fs.mkdirSync(workDir,{recursive:true});
  const {isFabric,neoV,fabApiV,fabLoader,gradleV} = getVersionConfig(loader,mcVersion);
  const pkg = `com.modgen.${modId.replace(/[^a-z0-9]/g,'')}`;
  console.log(`[build] Gradle ${gradleV} | ${loader} ${mcVersion} | neoV=${neoV}`);

  wf(workDir,'gradle/wrapper/gradle-wrapper.properties',
`distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleV}-bin.zip
networkTimeout=180000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists`);

  wf(workDir,'gradlew','#!/bin/sh\nDIRNAME=$(cd "$(dirname "$0")" && pwd)\nexec java -jar "$DIRNAME/gradle/wrapper/gradle-wrapper.jar" "$@"');
  fs.chmodSync(path.join(workDir,'gradlew'),'755');
  wf(workDir,'gradlew.bat','@echo off\njava -jar "%~dp0gradle\\wrapper\\gradle-wrapper.jar" %*');

  if (isFabric) {
    wf(workDir,'settings.gradle',
`pluginManagement {
    repositories {
        maven { url = 'https://maven.fabricmc.net/' }
        mavenCentral()
        gradlePluginPortal()
    }
}
rootProject.name = "${modId}"`);
    wf(workDir,'gradle.properties',
`minecraft_version=${mcVersion}
yarn_mappings=${mcVersion}+build.1
loader_version=${fabLoader}
fabric_version=${fabApiV}
java_version=21
maven_group=${pkg}
mod_id=${modId}
mod_name=${modName}
mod_version=1.0.0
mod_authors=ModGen
mod_description=Generated mod
org.gradle.jvmargs=-Xmx2G
org.gradle.daemon=false
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.configuration-cache=false`);
    wf(workDir,'build.gradle',
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
tasks.withType(JavaCompile).configureEach { options.encoding = 'UTF-8' }`);
  } else {
    // NeoForge — exact match with uploaded template
    wf(workDir,'settings.gradle',
`pluginManagement {
    repositories {
        maven { url = 'https://maven-central.storage.googleapis.com' }
        mavenCentral()
        gradlePluginPortal()
        maven { url = 'https://maven.neoforged.net/releases' }
    }
}
plugins {
    id 'org.gradle.toolchains.foojay-resolver-convention' version '0.8.0'
}
rootProject.name = "${modId}"`);
    wf(workDir,'gradle.properties',
`minecraft_version=${mcVersion}
neo_version=${neoV}
java_version=21
maven_group=${pkg}
mod_id=${modId}
mod_name=${modName}
mod_version=1.0.0
mod_authors=ModGen
mod_description=Generated mod
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=512m -XX:+UseG1GC -XX:+ParallelRefProcEnabled -Dfile.encoding=UTF-8
org.gradle.daemon=false
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.configuration-cache=false
org.gradle.configureondemand=true
org.gradle.console=plain
org.gradle.vfs.watch=false
org.gradle.workers.max=4
systemProp.org.gradle.internal.http.connectionTimeout=180000
systemProp.org.gradle.internal.http.socketTimeout=180000
systemProp.org.gradle.internal.repository.max.retries=5
systemProp.org.gradle.internal.repository.initial.backoff=1000`);
    wf(workDir,'build.gradle',
`plugins {
    id 'java-library'
    id 'eclipse'
    id 'idea'
    id 'maven-publish'
    id 'net.neoforged.gradle.userdev' version '7.0.163'
}
version = project.mod_version
group = project.maven_group
base { archivesName = project.mod_id }
java.toolchain.languageVersion = JavaLanguageVersion.of(project.java_version.toInteger())
runs {
    configureEach {
        systemProperty 'forge.logging.markers', 'REGISTRIES'
        systemProperty 'forge.logging.console.level', 'debug'
        modSource project.sourceSets.main
    }
    client { systemProperty 'forge.enabledGameTestNamespaces', project.mod_id }
    server { systemProperty 'forge.enabledGameTestNamespaces', project.mod_id; programArgument '--nogui' }
}
sourceSets.main.resources { srcDir 'src/generated/resources' }
repositories {
    maven { url = 'https://maven-central.storage.googleapis.com' }
    mavenCentral()
}
dependencies {
    implementation "net.neoforged:neoforge:\${neo_version}"
}
tasks.withType(ProcessResources).configureEach {
    var replaceProperties = [
        minecraft_version:minecraft_version, neo_version:neo_version,
        mod_id:mod_id, mod_name:mod_name, mod_version:mod_version,
        mod_authors:mod_authors, mod_description:mod_description
    ]
    inputs.properties replaceProperties
    filesMatching(['META-INF/neoforge.mods.toml']) { expand replaceProperties + [project:project] }
}
tasks.withType(JavaCompile).configureEach { options.encoding = 'UTF-8' }
tasks.withType(Jar).configureEach {
    manifest {
        attributes(['Specification-Title':mod_id,'Specification-Vendor':mod_authors,
            'Specification-Version':'1','Implementation-Title':project.name,
            'Implementation-Version':project.jar.archiveVersion,'Implementation-Vendor':mod_authors])
    }
}`);
  }

  // AI-generated files
  for (const [fp,c] of Object.entries(generatedFiles)) wf(workDir, fp, c);

  // Default configs if missing
  const hasFabric = Object.keys(generatedFiles).some(f=>f.includes('fabric.mod.json'));
  const hasToml   = Object.keys(generatedFiles).some(f=>f.includes('neoforge.mods.toml'));

  if (isFabric && !hasFabric) {
    wf(workDir,'src/main/resources/fabric.mod.json', JSON.stringify({
      schemaVersion:1, id:modId, version:'1.0.0', name:modName,
      description:'Generated mod', authors:['ModGen'], environment:'*',
      entrypoints:{main:[`${pkg}.${modName}`]},
      depends:{fabricloader:`>=${fabLoader}`,'fabric-api':'*',minecraft:mcVersion}
    },null,2));
  }
  if (!isFabric && !hasToml) {
    wf(workDir,'src/main/resources/META-INF/neoforge.mods.toml',
`modLoader="javafml"
loaderVersion="[4,)"
license="All Rights Reserved"
[[mods]]
modId="${modId}"
version="\${mod_version}"
displayName="\${mod_name}"
authors="\${mod_authors}"
description='''\${mod_description}'''
[[dependencies.${modId}]]
    modId="neoforge"
    type="required"
    versionRange="[${neoV},)"
    ordering="NONE"
    side="BOTH"
[[dependencies.${modId}]]
    modId="minecraft"
    type="required"
    versionRange="[${mcVersion},1.22)"
    ordering="NONE"
    side="BOTH"`);
  }
}

function wf(base, relPath, content) {
  const full = path.join(base, relPath);
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full, content, 'utf8');
}

// ── Run Gradle ────────────────────────────────────────────────────────
function runGradle(workDir, loader, mcVersion) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gradle', [
      'build','--no-daemon','--parallel','--no-scan','-x','test',
    ], {
      cwd: workDir,
      env: {
        ...process.env,
        GRADLE_USER_HOME: path.join(os.tmpdir(),'gradle_cache'),
        JAVA_HOME: process.env.JAVA_HOME||'/opt/java/openjdk',
      },
      timeout: 10*60*1000
    });
    let out='';
    proc.stdout.on('data',d=>{out+=d;process.stdout.write(d);});
    proc.stderr.on('data',d=>{out+=d;process.stderr.write(d);});
    proc.on('close',code=>{
      if (code===0) resolve(out);
      else reject(new Error(`Gradle exited with code ${code}\n\n${out.slice(-4000)}`));
    });
    proc.on('error',reject);
  });
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

app.listen(PORT, ()=>console.log(`MC Mod Compiler running on port ${PORT}`));
