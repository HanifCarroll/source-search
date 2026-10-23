export function typedMessage(text:string) {
  const shared=(s:string)=>Buffer.concat([Buffer.from([0x84,Buffer.byteLength(s)]),Buffer.from(s)]);
  const cls=(s:string)=>Buffer.concat([Buffer.from([0x84]),shared(s),Buffer.from([0])]);
  const body=Buffer.from(text),length=body.length<128 ? Buffer.from([body.length]) : Buffer.from([0x81,body.length&255,body.length>>8]);
  return Buffer.concat([Buffer.from([4,11]),Buffer.from("streamtyped"),Buffer.from([0x81,0xe8,3]),shared("@"),Buffer.from([0x84]),cls("NSAttributedString"),cls("NSObject"),Buffer.from([0x85,0x92,0x84]),cls("NSString"),Buffer.from([0x85]),shared("+"),length,body,Buffer.from([0x86,0x86])]);
}
