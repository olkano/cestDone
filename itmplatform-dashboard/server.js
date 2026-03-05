const express = require('express');
const https = require('https');
const dns = require('dns/promises');
const tls = require('tls');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;
const TARGET_URL = 'https://itmplatform.com';

function followRedirects(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    const start = Date.now();
    let redirectCount = 0;

    function doRequest(currentUrl) {
      const mod = currentUrl.startsWith('https') ? https : require('http');
      const req = mod.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < maxRedirects) {
          redirectCount++;
          res.resume();
          const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, currentUrl).href;
          doRequest(next);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            reachable: true,
            statusCode: res.statusCode,
            finalUrl: currentUrl,
            redirectCount,
            responseTime: Date.now() - start,
            responseSize: body.length,
            headers: res.headers,
            body: body.toString(),
          });
        });
      });
      req.on('error', (err) => {
        resolve({
          reachable: false,
          statusCode: null,
          finalUrl: currentUrl,
          redirectCount,
          responseTime: Date.now() - start,
          responseSize: 0,
          error: err.message,
        });
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolve({
          reachable: false,
          statusCode: null,
          finalUrl: currentUrl,
          redirectCount,
          responseTime: Date.now() - start,
          responseSize: 0,
          error: 'Request timed out',
        });
      });
    }

    doRequest(url);
  });
}

const TARGET_HOST = 'itmplatform.com';

function resolveDns(hostname) {
  const start = Date.now();
  return Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
    dns.resolveMx(hostname),
    dns.resolveNs(hostname),
  ]).then(([a, aaaa, mx, ns]) => ({
    resolveTime: Date.now() - start,
    a: a.status === 'fulfilled' ? a.value : [],
    aaaa: aaaa.status === 'fulfilled' ? aaaa.value : [],
    mx: mx.status === 'fulfilled' ? mx.value.sort((x, y) => x.priority - y.priority) : [],
    ns: ns.status === 'fulfilled' ? ns.value : [],
  }));
}

function getSSLCert(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect(443, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate();
      const protocol = socket.getProtocol();
      socket.end();
      const validTo = new Date(cert.valid_to);
      const daysUntilExpiry = Math.floor((validTo - Date.now()) / (1000 * 60 * 60 * 24));
      resolve({
        subject: cert.subject?.CN || 'N/A',
        issuer: cert.issuer?.O || 'N/A',
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        daysUntilExpiry,
        serialNumber: cert.serialNumber,
        protocol,
      });
    });
    socket.on('error', (err) => {
      resolve({ error: err.message });
    });
    socket.setTimeout(10000, () => {
      socket.destroy();
      resolve({ error: 'TLS connection timed out' });
    });
  });
}

app.get('/', async (req, res) => {
  const [availability, dnsInfo, sslInfo] = await Promise.all([
    followRedirects(TARGET_URL),
    resolveDns(TARGET_HOST),
    getSSLCert(TARGET_HOST),
  ]);

  const securityHeaders = [
    'strict-transport-security',
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'x-xss-protection',
    'referrer-policy',
    'permissions-policy',
  ];
  const headers = availability.headers || {};

  let seo = {};
  if (availability.body) {
    const $ = cheerio.load(availability.body);
    seo = {
      title: $('title').first().text() || 'N/A',
      description: $('meta[name="description"]').attr('content') || 'N/A',
      keywords: $('meta[name="keywords"]').attr('content') || 'N/A',
      ogTitle: $('meta[property="og:title"]').attr('content') || 'N/A',
      ogDescription: $('meta[property="og:description"]').attr('content') || 'N/A',
      ogImage: $('meta[property="og:image"]').attr('content') || 'N/A',
      canonical: $('link[rel="canonical"]').attr('href') || 'N/A',
      robots: $('meta[name="robots"]').attr('content') || 'N/A',
      h1s: $('h1').map((_, el) => $(el).text().trim()).get(),
      linkCount: $('a').length,
    };
  }

  const statusColor = availability.reachable ? '#16a34a' : '#dc2626';
  const statusLabel = availability.reachable ? 'Reachable' : 'Unreachable';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ITMPlatform Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #333; padding: 2rem; }
    h1 { text-align: center; margin-bottom: 2rem; color: #1a1a2e; }
    .container { max-width: 960px; margin: 0 auto; }
    .card { background: #fff; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { margin-bottom: 1rem; color: #16213e; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    .placeholder { color: #888; font-style: italic; }
    .metric { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f0f0f0; }
    .metric:last-child { border-bottom: none; }
    .metric-label { font-weight: 500; }
    .metric-value { font-family: 'Courier New', monospace; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; color: #fff; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <h1>ITMPlatform Dashboard</h1>
    <div class="card">
      <h2>Site Availability</h2>
      <div class="metric">
        <span class="metric-label">Status</span>
        <span class="badge" style="background:${statusColor}">${statusLabel}</span>
      </div>
      <div class="metric">
        <span class="metric-label">HTTP Status Code</span>
        <span class="metric-value">${availability.statusCode ?? 'N/A'}</span>
      </div>
      <div class="metric">
        <span class="metric-label">URL</span>
        <span class="metric-value">${TARGET_URL}</span>
      </div>${availability.finalUrl !== TARGET_URL ? `
      <div class="metric">
        <span class="metric-label">Final URL</span>
        <span class="metric-value">${availability.finalUrl}</span>
      </div>` : ''}
      <div class="metric">
        <span class="metric-label">Redirects</span>
        <span class="metric-value">${availability.redirectCount}</span>
      </div>${availability.error ? `
      <div class="metric">
        <span class="metric-label">Error</span>
        <span class="metric-value" style="color:#dc2626">${availability.error}</span>
      </div>` : ''}
    </div>
    <div class="card">
      <h2>Page Load Performance</h2>
      <div class="metric">
        <span class="metric-label">Response Time</span>
        <span class="metric-value">${availability.responseTime} ms</span>
      </div>
      <div class="metric">
        <span class="metric-label">Response Size</span>
        <span class="metric-value">${(availability.responseSize / 1024).toFixed(2)} KB</span>
      </div>
    </div>
    <div class="card">
      <h2>DNS Resolution</h2>
      <div class="metric">
        <span class="metric-label">Resolution Time</span>
        <span class="metric-value">${dnsInfo.resolveTime} ms</span>
      </div>
      <div class="metric">
        <span class="metric-label">A Records (IPv4)</span>
        <span class="metric-value">${dnsInfo.a.length ? dnsInfo.a.join(', ') : 'None'}</span>
      </div>
      <div class="metric">
        <span class="metric-label">AAAA Records (IPv6)</span>
        <span class="metric-value">${dnsInfo.aaaa.length ? dnsInfo.aaaa.join(', ') : 'None'}</span>
      </div>
      <div class="metric">
        <span class="metric-label">MX Records</span>
        <span class="metric-value">${dnsInfo.mx.length ? dnsInfo.mx.map(r => r.exchange + ' (pri ' + r.priority + ')').join(', ') : 'None'}</span>
      </div>
      <div class="metric">
        <span class="metric-label">NS Records</span>
        <span class="metric-value">${dnsInfo.ns.length ? dnsInfo.ns.join(', ') : 'None'}</span>
      </div>
    </div>
    <div class="card">
      <h2>SSL Certificate</h2>${sslInfo.error ? `
      <div class="metric">
        <span class="metric-label">Error</span>
        <span class="metric-value" style="color:#dc2626">${sslInfo.error}</span>
      </div>` : `
      <div class="metric">
        <span class="metric-label">Subject</span>
        <span class="metric-value">${sslInfo.subject}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Issuer</span>
        <span class="metric-value">${sslInfo.issuer}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Valid From</span>
        <span class="metric-value">${sslInfo.validFrom}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Valid To</span>
        <span class="metric-value">${sslInfo.validTo}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Days Until Expiry</span>
        <span class="metric-value" style="color:${sslInfo.daysUntilExpiry < 30 ? '#dc2626' : '#16a34a'}">${sslInfo.daysUntilExpiry}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Serial Number</span>
        <span class="metric-value">${sslInfo.serialNumber}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Protocol</span>
        <span class="metric-value">${sslInfo.protocol}</span>
      </div>`}
    </div>
    <div class="card">
      <h2>HTTP Headers</h2>
      <h3 style="margin:0.8rem 0 0.5rem;color:#374151;font-size:0.95em">Security Headers</h3>
${securityHeaders.map(h => {
  const present = h in headers;
  return `      <div class="metric">
        <span class="metric-label">${h}</span>
        <span class="badge" style="background:${present ? '#16a34a' : '#dc2626'}">${present ? 'Present' : 'Missing'}</span>
      </div>`;
}).join('\n')}
      <h3 style="margin:0.8rem 0 0.5rem;color:#374151;font-size:0.95em">All Response Headers</h3>
${Object.entries(headers).map(([k, v]) => `      <div class="metric">
        <span class="metric-label" style="min-width:200px">${k}</span>
        <span class="metric-value" style="word-break:break-all;text-align:right;max-width:60%">${Array.isArray(v) ? v.join(', ') : v}</span>
      </div>`).join('\n')}
    </div>
    <div class="card">
      <h2>SEO / Meta Data</h2>${availability.body ? `
      <div class="metric">
        <span class="metric-label">Page Title</span>
        <span class="metric-value">${seo.title}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Meta Description</span>
        <span class="metric-value" style="text-align:right;max-width:60%;word-break:break-word">${seo.description}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Meta Keywords</span>
        <span class="metric-value">${seo.keywords}</span>
      </div>
      <div class="metric">
        <span class="metric-label">og:title</span>
        <span class="metric-value">${seo.ogTitle}</span>
      </div>
      <div class="metric">
        <span class="metric-label">og:description</span>
        <span class="metric-value" style="text-align:right;max-width:60%;word-break:break-word">${seo.ogDescription}</span>
      </div>
      <div class="metric">
        <span class="metric-label">og:image</span>
        <span class="metric-value" style="word-break:break-all;text-align:right;max-width:60%">${seo.ogImage}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Canonical URL</span>
        <span class="metric-value" style="word-break:break-all">${seo.canonical}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Robots</span>
        <span class="metric-value">${seo.robots}</span>
      </div>
      <div class="metric">
        <span class="metric-label">H1 Tags</span>
        <span class="metric-value">${seo.h1s.length ? seo.h1s.join(', ') : 'None'}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Total Links</span>
        <span class="metric-value">${seo.linkCount}</span>
      </div>` : `
      <p class="placeholder">No HTML body available</p>`}
    </div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
