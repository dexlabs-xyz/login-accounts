/** Run against npm run dev:oidc. Uses Chrome virtual passkeys against the real shared server. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { Device } from '../../../../e2e/helpers.ts';
const browser=await chromium.launch({executablePath:process.env.OIDC_CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 // This device cannot open wallets: OIDC must work without wallet access.
 const device=await Device.add(page,{prf:false});
 let passkeyChecks=0;
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/login/verify') passkeyChecks++;});
 const email=`oidc-${Date.now()}@example.com`;
 await page.goto('http://localhost:5190');
 await page.getByRole('link',{name:'Continue with Login',exact:true}).click();
 await page.getByLabel('Email',{exact:true}).fill(email);
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 const outbox=await (await page.request.get('http://localhost:5180/api/dev/outbox')).json();
 const code=outbox.emails.find((entry: {to:string;subject:string})=>entry.to===email)?.subject.match(/\d{6}/)?.[0];
 assert.ok(code);
 await page.getByLabel('6-digit code').fill(code);
 await page.getByRole('button',{name:'Verify',exact:true}).click();
 await page.getByRole('button',{name:'Allow and continue'}).click();
 await page.getByRole('heading',{name:'Signed in to the chess demo'}).waitFor();
 const first=await page.locator('code').textContent();
 assert.ok((await page.textContent('body'))?.includes('Verified human: No'));
 await page.getByRole('link',{name:'Try another flow'}).click();
 await page.getByRole('link',{name:'Try a second app'}).click();
 await page.getByRole('button',{name:'Allow and continue'}).click();
 await page.getByRole('heading',{name:'Signed in to the second demo app'}).waitFor();
 assert.ok(first!==await page.locator('code').textContent());
 await page.getByRole('link',{name:'Try another flow'}).click();
 await page.getByRole('link',{name:'Continue with Login',exact:true}).click();
 await page.getByRole('heading',{name:'Signed in to the chess demo'}).waitFor();
 assert.ok(first===await page.locator('code').textContent());
 await page.getByRole('link',{name:'Try another flow'}).click();
 const checksBeforeFresh=passkeyChecks;
 await page.getByRole('link',{name:'Require a fresh sign-in'}).click();
 await page.getByRole('heading',{name:'Confirm it’s you'}).waitFor();
 // Chrome's virtual authenticator completes the conditional passkey prompt automatically.
 await page.getByRole('heading',{name:'Signed in to the chess demo'}).waitFor();
 assert.ok(passkeyChecks>checksBeforeFresh);
 // Real logout must invalidate the shared session used by OIDC.
 await device.setResponds(false);
 await page.request.post('http://localhost:5180/api/logout',{data:{}});
 await page.goto('http://localhost:5190');
 await page.getByRole('link',{name:'Continue with Login',exact:true}).click();
 await page.getByRole('heading',{name:'Sign in to continue'}).waitFor();
 await page.getByRole('button',{name:'Cancel and go back to the app'}).click();
 await page.getByRole('heading',{name:'Sign-in did not complete'}).waitFor();
 console.log('Browser checks passed: real passkey signup without wallet access, validated OIDC sign-in, per-app IDs, consent, fresh passkey authentication, logout and cancellation.');
} finally {await browser.close();}
