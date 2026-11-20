import type {ButtonHTMLAttributes} from 'react'

export function ReportLoading({label='Loading your report…',compact=false}:{label?:string;compact?:boolean}) {
 const Container=compact?'span':'div'
 return <Container className="bb-report-loading" data-compact={compact||undefined} role="status">
  <span className="bb-pull-spinner bb-report-loading-spinner" aria-hidden="true"><svg viewBox="0 0 32 32"><circle className="bb-pull-progress" cx="16" cy="16" r="12" pathLength="100" strokeDasharray="100" strokeDashoffset="25"/></svg></span>
  <span className="sr-only">{label}</span>
 </Container>
}

export function SavingButton({saving,children,className='',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{saving:boolean}) {
 return <button {...props} className={className+' bb-saving-button'} disabled={saving||props.disabled}
  aria-busy={saving||undefined} data-saving={saving||undefined} aria-label={props['aria-label']??(typeof children==='string'?children:undefined)}>
  <span className="bb-saving-label">{children}</span>
  {saving&&<span className="bb-saving-indicator" aria-hidden="true"><ReportLoading compact label="Saving…"/></span>}
 </button>
}
