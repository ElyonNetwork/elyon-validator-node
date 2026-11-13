package amount

import (
	"math/big"
	"testing"
)

func TestParse(t *testing.T) {
	good := map[string]string{"10": "10000000", "0.5": "500000", ".25": "250000", "1.000000": "1000000", "1.0000000": "1000000", "+3": "3000000", "0": "0", "007": "7000000"}
	for in, want := range good {
		v, err := Parse(in, 6)
		if err != nil || v.String() != want {
			t.Errorf("%q -> %v %v, want %s", in, v, err, want)
		}
	}
	for _, in := range []string{"", "-1", "1,5", "1.2.3", "1e6", "abc", "1.0000001", ".", "0x10", "1 000", "∞"} {
		if _, err := Parse(in, 6); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	if _, err := ParsePositive("0.000", 6); err == nil {
		t.Error("zero accepted as positive")
	}
	if v, _ := Parse("1", 18); v.String() != "1000000000000000000" {
		t.Error("18 decimals")
	}
	if _, err := Parse("1.5", 0); err == nil {
		t.Error("decimals on a 0-decimal token accepted")
	}
}

func TestFormat(t *testing.T) {
	cases := []struct {
		v    string
		d    int
		want string
	}{{"1500000", 6, "1.5"}, {"1", 6, "0.000001"}, {"12000000", 6, "12"}, {"0", 18, "0"}, {"-2500000", 6, "-2.5"}, {"123", 0, "123"}}
	for _, c := range cases {
		v, _ := new(big.Int).SetString(c.v, 10)
		if got := Format(v, c.d); got != c.want {
			t.Errorf("Format(%s,%d)=%s want %s", c.v, c.d, got, c.want)
		}
	}
	v, _ := new(big.Int).SetString("1234567890123456789", 10)
	if got := FormatMax(v, 18, 4); got != "1.2345" {
		t.Errorf("FormatMax %s", got)
	}
	if got := FormatSig(big.NewInt(14481364986883), 18, 6); got != "0.0000144813" {
		t.Errorf("FormatSig small %s", got)
	}
	if Group("68819.1") != "68,819.1" || Group("-1234567") != "-1,234,567" || Group("999") != "999" {
		t.Error("Group")
	}
	if Price(68819.1) != "68,819.10" || Price(1.5) != "1.5000" || Price(0.000123456) != "0.0001235" {
		t.Errorf("Price %s %s %s", Price(68819.1), Price(1.5), Price(0.000123456))
	}
	if p, err := ParsePercent("50%"); err != nil || p != 5000 {
		t.Error("percent")
	}
	if _, err := ParsePercent("101"); err == nil {
		t.Error("101% accepted")
	}
	if v, err := FromFloat(68819.1, 18); err != nil || v.String() != "68819100000000000000000" {
		t.Errorf("FromFloat %v %v", v, err)
	}
}
