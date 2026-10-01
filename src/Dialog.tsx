import { useEffect,useRef,type ReactNode } from 'react';
import { X } from 'lucide-react';
export default function Dialog({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}){
  const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;document.body.style.overflow='hidden';ref.current?.querySelector<HTMLElement>('button,input,select,textarea')?.focus();
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape')close.current();if(e.key!=='Tab'||!ref.current)return;const elements=Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]'));const first=elements[0],last=elements.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}};
    document.addEventListener('keydown',key);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',key);previous?.focus();};
  },[]);
  return <div className="modal-backdrop"><section ref={ref} className={`dialog ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20}/></button></div>{children}</section></div>;
}
