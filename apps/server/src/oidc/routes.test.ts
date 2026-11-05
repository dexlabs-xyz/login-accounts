import { expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { createApp } from '../app.ts';
import { openDb } from '../db.ts';
import { loadConfig } from '../config.ts';
import type { Server } from 'node:http';

it('mounts OIDC in the shared Hono app, uses canonical public URLs and reads the passkey session in milliseconds', async () => {
  const db=openDb(':memory:');
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('test-user','test@example.com','test-handle',Date.now());
  const {app,sessions}=createApp({config:loadConfig(),db,mailer:{async send(){}},oidcIssuer:'http://localhost:5180/oidc'});
  // Test-only route uses the passkey component's public session API.
  app.post('/test/session',c=>{sessions.start(c,'test-user');return c.json({ok:true});});
  const server=await new Promise<Server>(resolve=>{
    const s=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'},()=>resolve(s as Server));
  });
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const cookies=new Map<string,string>();
  const request=async(path:string,method='GET')=>{
    const response=await fetch(origin+path,{method,redirect:'manual',headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}});
    for(const value of response.headers.getSetCookie()){
      const pair=value.split(';')[0]!, at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));
    }
    return response;
  };
  try{
    const discovery=await (await request('/oidc/.well-known/openid-configuration')).json();
    expect(discovery.issuer).toBe('http://localhost:5180/oidc');
    expect(discovery.authorization_endpoint).toBe('http://localhost:5180/oidc/auth');
    expect((await request('/api/me')).status).toBe(401);
    await request('/test/session','POST');
    expect((await request('/api/me')).status).toBe(200);
    const auth=await request('/oidc/auth?'+new URLSearchParams({client_id:'chess-local',redirect_uri:'http://localhost:5190/callback',response_type:'code',scope:'openid',code_challenge:'a'.repeat(43),code_challenge_method:'S256'}));
    expect(auth.status).toBe(303);
    const interaction=await request(new URL(auth.headers.get('location')!,'http://localhost:5180').pathname);
    expect(interaction.status).toBe(303);
    // A valid shared passkey session must be accepted, not sent back to /signin.
    expect(interaction.headers.get('location')?.includes('/signin')).toBe(false);
    expect(interaction.headers.get('location')?.includes('/oidc/auth/')).toBe(true);
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();
  }
});
