from django import forms

class ContactForm(forms.Form):
    name = forms.CharField(max_length=100, label="שם מלא")
    email = forms.EmailField(label="אימייל")
    subject = forms.CharField(max_length=200, label="נושא")
    message = forms.CharField(widget=forms.Textarea, label="הודעה")