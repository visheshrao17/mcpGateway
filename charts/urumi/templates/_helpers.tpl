{{- define "urumi.storeHost" -}}{{ .Values.hosts.store }}.{{ .Values.domain }}{{- end -}}
{{- define "urumi.appHost" -}}{{ .Values.hosts.app }}.{{ .Values.domain }}{{- end -}}
{{- define "urumi.scheme" -}}{{ if .Values.tls.enabled }}https{{ else }}http{{ end }}{{- end -}}

{{- define "urumi.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
All generated credentials, created once and read back from the cluster on every upgrade,
so a `helm upgrade` never rotates a password the database already uses.
*/}}
{{- define "urumi.secrets" -}}
{{- if not .Values._secrets -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace "urumi-generated").data | default dict -}}
{{- $s := dict -}}
{{- range $key, $gen := dict
    "mariadb-root-password" (randAlphaNum 32)
    "mariadb-password" (randAlphaNum 32)
    "wp-admin-password" (randAlphaNum 20)
    "woo-consumer-key" (printf "ck_%s" (sha1sum (randAlphaNum 40)))
    "woo-consumer-secret" (printf "cs_%s" (sha1sum (randAlphaNum 40)))
    "woo-mcp-token" (randAlphaNum 40)
    "notes-mcp-token" (randAlphaNum 40)
    "postgres-password" (randAlphaNum 32)
    "master-key" (randBytes 32)
    "gateway-admin-password" (randAlphaNum 20)
-}}
{{- $_ := set $s $key (ternary (index $existing $key | default "" | b64dec) $gen (hasKey $existing $key)) -}}
{{- end -}}
{{- $_ := set .Values "_secrets" $s -}}
{{- end -}}
{{- end -}}

{{- define "urumi.secret" -}}
{{- include "urumi.secrets" .root -}}
{{- index .root.Values._secrets .key | b64enc -}}
{{- end -}}

{{- define "urumi.restricted" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "urumi.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ . }}
runAsGroup: {{ . }}
fsGroup: {{ . }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "urumi.storageClass" -}}
{{- if .Values.storageClass }}
storageClassName: {{ .Values.storageClass }}
{{- end }}
{{- end -}}
