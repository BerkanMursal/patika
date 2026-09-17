'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main style={{padding:48}}><h1>Mimari görünümü yüklenemedi.</h1><p style={{margin:'18px 0'}}>Sayfayı yeniden açmayı deneyin.</p><button style={{padding:12,border:'1px solid #ccd7e6',borderRadius:7}} onClick={reset}>Yeniden dene</button></main>;}
