const deny=(message,status=403)=>{throw Object.assign(new Error(message),{status})};
const linked=(state,studentId,personId)=>{const s=(state.students||[]).find(x=>x.id===studentId);return !!s&&(s.titulares||[]).includes(personId)};
const findRequest=(state,id)=>{const r=(state.requests||[]).find(x=>x.id===id);if(!r)deny('request_not_found',404);return r};
export function applyPrototypeCommand(state,user,command){if(!state.prototypeState)deny('prototype_not_initialized',409);const doc=structuredClone(state.prototypeState),personId=user.prototypeIdentity?.personId;
 if(command.type==='cancel_request'){const r=findRequest(doc,command.requestId);if(user.role!=='parent'||!linked(doc,r.studentId,personId))deny('forbidden_request_family');if(!['pendiente','aprobada'].includes(r.status))deny('request_not_cancellable',409);r.status='cancelada';r.history=r.history||[];r.history.push({ts:Date.now(),text:`Cancelada por ${personId}`})}
 else if(command.type==='confirm_pickup'){const r=findRequest(doc,command.requestId);if(user.role!=='parent'||!linked(doc,r.studentId,personId))deny('forbidden_request_family');if(r.status!=='aprobada')deny('request_not_confirmable',409);r.confirmation={...(r.confirmation||{}),status:command.confirmed?'confirmada':'negada',byPerson:personId,at:Date.now()}}
 else if(command.type==='bus_opt_out'){if(user.role!=='parent'||!linked(doc,command.studentId,personId))deny('forbidden_parent_bus_family');const trip=doc.busTrips?.[command.tripKey];if(!trip)deny('trip_not_found',404);trip.noBus=[...new Set([...(trip.noBus||[]),command.studentId])]}
 else deny('unsupported_prototype_command',400);
 return doc}
