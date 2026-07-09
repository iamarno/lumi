{{- define "lumi.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "lumi.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "lumi.labels" -}}
app.kubernetes.io/name: {{ include "lumi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "lumi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lumi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Core image ref — digest wins over tag */}}
{{- define "lumi.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}
{{- end -}}

{{/* Modules carrier image ref — digest wins over tag */}}
{{- define "lumi.modulesImage" -}}
{{- if .Values.modules.digest -}}
{{ .Values.modules.image }}@{{ .Values.modules.digest }}
{{- else -}}
{{ .Values.modules.image }}:{{ .Values.modules.tag }}
{{- end -}}
{{- end -}}

{{/* Name of the Secret consumed via envFrom */}}
{{- define "lumi.secretName" -}}
{{- if .Values.existingSecret -}}
{{ .Values.existingSecret }}
{{- else -}}
{{ include "lumi.fullname" . }}-env
{{- end -}}
{{- end -}}
